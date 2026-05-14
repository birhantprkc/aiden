// core/tools/nowPlaying.ts — Live media session query via Windows WinRT
// Uses GlobalSystemMediaTransportControlsSessionManager (works for Spotify,
// YouTube in browser, Windows Media Player, and any SMTC-registered app).
//
// v4.1.4-media: the WinRT `Await` PS5.1 reflection bridge moved into the
// shared helper `tools/v4/system/_psHelpers.ts::winRtAwaitPreamble()` so
// the three GSMTC callers (this file + mediaSessions + mediaTransport)
// share one canonical implementation.

import { exec } from 'child_process'
import { promisify } from 'util'
import { winRtAwaitPreamble } from '../../tools/v4/system/_psHelpers'

const execAsync = promisify(exec)

export interface NowPlayingResult {
  isPlaying:      boolean
  app?:           string
  title?:         string
  artist?:        string
  album?:         string
  playbackStatus?: string
  message?:       string
}

const PS_SCRIPT = `
${winRtAwaitPreamble()}
$mgType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($mgType::RequestAsync()) $mgType
$s = $mgr.GetCurrentSession()
if ($s) {
    $pType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
    $p = Await ($s.TryGetMediaPropertiesAsync()) $pType
    $pb = $s.GetPlaybackInfo()
    @{ app=$s.SourceAppUserModelId; title=$p.Title; artist=$p.Artist; album=$p.AlbumTitle; isPlaying=($pb.PlaybackStatus -eq 'Playing'); playbackStatus=$pb.PlaybackStatus.ToString() } | ConvertTo-Json -Compress
} else {
    '{"isPlaying":false,"message":"No media session active"}'
}
`.trim()

export async function getNowPlaying(): Promise<NowPlayingResult> {
  const { stdout } = await execAsync(PS_SCRIPT, {
    shell: 'powershell.exe',
    timeout: 5000,
  })
  const raw = stdout.trim()
  if (!raw) return { isPlaying: false, message: 'No output from media session query' }

  const parsed = JSON.parse(raw) as NowPlayingResult

  // Normalize app ID to a friendly name where possible
  if (parsed.app) {
    const id = parsed.app.toLowerCase()
    if (id.includes('spotify'))        parsed.app = 'Spotify'
    else if (id.includes('msedge'))    parsed.app = 'Microsoft Edge'
    else if (id.includes('chrome'))    parsed.app = 'Google Chrome'
    else if (id.includes('firefox'))   parsed.app = 'Firefox'
    else if (id.includes('vlc'))       parsed.app = 'VLC'
    else if (id.includes('groove'))    parsed.app = 'Groove Music'
    else if (id.includes('mediaplay')) parsed.app = 'Windows Media Player'
  }

  return parsed
}
