// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/channels/discord.ts — Discord channel adapter.
//
// Config (env vars):
//   DISCORD_BOT_TOKEN           — required; adapter stays disabled if absent
//   DISCORD_ALLOWED_GUILDS      — optional comma-separated guild IDs
//   DISCORD_ALLOWED_CHANNELS    — optional comma-separated channel IDs
//
// Features:
//   - Responds to direct messages and guild messages
//   - Slash commands: /aiden <prompt>  /aiden-help
//   - Allowlist enforcement for guilds and channels
//   - Ignores messages from other bots (no bot loops)
//   - Graceful degradation: missing token → disabled, no crash

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  DMChannel,
  type Interaction,
  type Message,
} from 'discord.js'
import { gateway } from '../gateway'
import type { ChannelAdapter } from './adapter'
import type { DeliveryBinding, DeliveryCapabilities } from '../deliveryContext'
import { noopLogger, type Logger } from '../v4/logger'

// v4.12 DC.3 — Discord's per-message hard limit. Replies longer than this were
// previously TRUNCATED (substring(0, 2000)); migrating onto the DeliveryContext
// seam chunks at this boundary instead, so nothing is lost.
const DISCORD_MAX_MESSAGE_CHARS = 2000

// v4.12 DC.3 — declared HONESTLY per what the seam actually routes after this
// slice (SH.1/DC.2 discipline). Only chunking is wired now; edit / media /
// voice / reactions are NOT routed through ctx.send, so they stay false/[] and
// their kinds return an honest not-supported receipt until a future slice wires
// them. (Slash commands still use interaction.editReply to resolve the deferred
// reply — that's the interaction-response mechanism, not a seam 'edit'
// capability, so `edit` is honestly false.)
const DISCORD_DELIVERY_CAPABILITIES: DeliveryCapabilities = {
  edit:              false,
  chunkLongMessages: true,   // the DC.3 fix — chunkAtBoundary(text, 2000)
  media:             [],
  voiceBubble:       false,
  reactions:         false,
}

/**
 * v4.12 DC.3 — split `text` into pieces no larger than `limit`, preferring a
 * newline boundary, then a space, then a hard cut; the split must fall in the
 * second half so a long token near the start doesn't force a tiny chunk. Same
 * algorithm Telegram uses (at 4096) — Discord chunks at 2000. Standalone here
 * to avoid touching the byte-identical Telegram adapter (DC.2).
 */
function chunkAtBoundary(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let cursor = text
  while (cursor.length > 0) {
    if (cursor.length <= limit) { out.push(cursor); break }
    let cut = cursor.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = cursor.lastIndexOf(' ', limit)
    if (cut < limit / 2) cut = limit
    out.push(cursor.slice(0, cut))
    cursor = cursor.slice(cut).replace(/^\s+/, '')
  }
  return out
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord'

  private client:          Client | null = null
  private token:           string
  private allowedGuilds:   Set<string>
  private allowedChannels: Set<string>
  private healthy          = false
  // Phase v4.1-1.3a — diagnostics route through the channel scope
  // logger; ChannelManager.register injects it. Default noop keeps
  // pre-attach calls silent.
  private log:             Logger = noopLogger()

  constructor() {
    this.token           = process.env.DISCORD_BOT_TOKEN          ?? ''
    const rawGuilds      = process.env.DISCORD_ALLOWED_GUILDS     ?? ''
    const rawChannels    = process.env.DISCORD_ALLOWED_CHANNELS   ?? ''
    this.allowedGuilds   = rawGuilds    ? new Set(rawGuilds.split(',').map(s => s.trim()).filter(Boolean))    : new Set()
    this.allowedChannels = rawChannels  ? new Set(rawChannels.split(',').map(s => s.trim()).filter(Boolean))  : new Set()
  }

  attachLogger(logger: Logger): void { this.log = logger }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.token) {
      this.log.info('Disabled — set DISCORD_BOT_TOKEN to enable')
      return
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })

    this.client.once(Events.ClientReady, async (c) => {
      this.log.info(`Connected as ${c.user.tag}`)
      this.healthy = true
      // Register outbound delivery so gateway.deliver() and broadcast() work
      gateway.registerChannel('discord', async (msg) => {
        return this.deliverToChannel(msg.channelId, msg.text)
      })
      // Register slash commands globally (takes ~1h to propagate on first run)
      await this.registerSlashCommands(c.user.id).catch((e: Error) =>
        this.log.warn(`Slash command registration failed: ${e.message}`),
      )
    })

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (!this.shouldHandle(message.author.id, message.guildId, message.channelId, message.author.bot)) return

      try {
        await (message.channel as TextChannel).sendTyping?.()
      } catch {}

      // v4.12 DC.3 — deliver through the DeliveryContext seam. The binding's
      // sink sends chunk 0 as a reply (preserves the "replying to" reference),
      // the rest as follow-on channel messages — so long replies chunk instead
      // of truncating. The gateway calls ctx.send('final', …); no direct send
      // here (exactly N chunk messages, no double-send).
      await this.processMessage(
        message.channelId, message.author.id, message.content,
        this.buildDeliveryBinding(async (chunk, i) => {
          if (i === 0) await message.reply(chunk)
          else await (message.channel as TextChannel).send(chunk)
        }),
      )
    })

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return

      const guildId   = interaction.guildId
      const channelId = interaction.channelId
      const userId    = interaction.user.id

      // Allowlist check
      if (this.allowedGuilds.size > 0 && guildId && !this.allowedGuilds.has(guildId)) {
        await interaction.reply({ content: '⚠️ This server is not authorized.', ephemeral: true })
        return
      }
      if (this.allowedChannels.size > 0 && !this.allowedChannels.has(channelId)) {
        await interaction.reply({ content: '⚠️ This channel is not authorized.', ephemeral: true })
        return
      }

      if (interaction.commandName === 'aiden') {
        const prompt = interaction.options.getString('prompt', true)
        await interaction.deferReply()
        // v4.12 DC.3 — through the seam. Chunk 0 resolves the deferred reply via
        // editReply (required to answer the interaction), the rest via followUp
        // — long replies chunk instead of truncating.
        await this.processMessage(
          channelId, userId, prompt,
          this.buildDeliveryBinding(async (chunk, i) => {
            if (i === 0) await interaction.editReply(chunk)
            else await interaction.followUp(chunk)
          }),
        )
      } else if (interaction.commandName === 'aiden-help') {
        await interaction.reply({
          content: '**Aiden** — your local AI assistant\n\n`/aiden <prompt>` — ask anything\n`/aiden-help` — show this message',
          ephemeral: true,
        })
      }
    })

    try {
      await this.client.login(this.token)
    } catch (e: any) {
      this.log.error(`Login failed: ${e.message}`)
      this.healthy = false
    }
  }

  async stop(): Promise<void> {
    this.healthy = false
    if (this.client) {
      gateway.unregisterChannel('discord')
      await this.client.destroy()
      this.client = null
    }
    this.log.info('Disconnected')
  }

  async send(channelId: string, message: string): Promise<void> {
    await this.deliverToChannel(channelId, message)
  }

  isHealthy(): boolean { return this.healthy }

  // ── Helpers ────────────────────────────────────────────────

  private shouldHandle(
    authorId:  string,
    guildId:   string | null,
    channelId: string,
    isBot:     boolean,
  ): boolean {
    if (isBot) return false
    if (this.allowedGuilds.size > 0 && guildId && !this.allowedGuilds.has(guildId))    return false
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(channelId)) return false
    return true
  }

  // v4.12 DC.3 — optional `delivery` binding (mirrors Telegram DC.2). When
  // present, gateway.routeMessage constructs the immutable per-turn ctx and
  // delivers the final reply through the seam (ctx.send('final', …) → the
  // binding's sink). When absent, behaviour is unchanged (returns the string).
  private async processMessage(
    channelId: string,
    userId: string,
    text: string,
    delivery?: DeliveryBinding,
  ): Promise<string> {
    try {
      return await gateway.routeMessage({
        channel:   'discord',
        channelId,
        userId,
        text,
        timestamp: Date.now(),
      }, delivery)
    } catch (e: any) {
      this.log.error(`routeMessage error: ${e.message}`)
      return '❌ Something went wrong. Try again.'
    }
  }

  /**
   * v4.12 DC.3 — the Discord DeliveryDriver + declared capabilities for one
   * turn. `deliver('final' | 'status')` CHUNKS at the 2000-char boundary and
   * sends each chunk via the caller-supplied `sink` (which owns the Discord
   * send primitive for its context — message.reply/channel.send for a message,
   * editReply/followUp for a slash interaction). This is the DC.3 payoff: long
   * replies chunk instead of truncating. Not-yet-wired kinds return an honest
   * not-supported receipt rather than silently dropping.
   */
  private buildDeliveryBinding(
    sink: (chunk: string, index: number) => Promise<void>,
  ): DeliveryBinding {
    return {
      capabilities: DISCORD_DELIVERY_CAPABILITIES,
      driver: {
        deliver: async (kind, payload) => {
          if (kind === 'final' || kind === 'status') {
            const chunks = chunkAtBoundary(payload.text ?? '', DISCORD_MAX_MESSAGE_CHARS)
            for (let i = 0; i < chunks.length; i++) await sink(chunks[i], i)
            return { ok: true, kind, chunks: chunks.length }
          }
          return {
            ok:    false,
            kind,
            error: `Discord DC.3 does not yet route '${kind}' delivery through the seam`,
          }
        },
      },
    }
  }

  private async deliverToChannel(channelId: string, text: string): Promise<boolean> {
    try {
      const ch = this.client?.channels.cache.get(channelId)
      if (ch && (ch instanceof TextChannel || ch instanceof DMChannel)) {
        // v4.12 DC.3 — chunk instead of truncate (was substring(0, 2000)); the
        // proactive gateway.deliver() / send() path inherits the fix too.
        for (const chunk of chunkAtBoundary(text, DISCORD_MAX_MESSAGE_CHARS)) {
          await ch.send(chunk)
        }
        return true
      }
      return false
    } catch (e: any) {
      this.log.error(`Delivery error: ${e.message}`)
      return false
    }
  }

  private async registerSlashCommands(appId: string): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.token)
    const commands = [
      new SlashCommandBuilder()
        .setName('aiden')
        .setDescription('Ask Aiden anything')
        .addStringOption(opt =>
          opt.setName('prompt').setDescription('Your message to Aiden').setRequired(true),
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName('aiden-help')
        .setDescription('Show Aiden capabilities')
        .toJSON(),
    ]
    await rest.put(Routes.applicationCommands(appId), { body: commands })
    this.log.info('Slash commands registered globally')
  }
}
