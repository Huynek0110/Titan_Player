import { app } from "electron"
import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { LibrarySettings, Playlist } from "../shared/types.js"
import { DEFAULT_EXTENSIONS } from "../shared/types.js"

interface PersistedState {
  version: number
  settings: LibrarySettings
  playlists: Playlist[]
  /** Track ids the user starred. */
  favourites: string[]
  /** Track ids the user has hidden from the library view. */
  hidden: string[]
}

const SCHEMA_VERSION = 1

function defaultSettings(): LibrarySettings {
  return {
    musicFolders: [],
    useSystemMusicFolder: true,
    extensions: DEFAULT_EXTENSIONS,
    lastView: "library",
    volume: 0.8,
    repeat: "off",
    shuffle: false,
    sortBy: "title",
    sortDir: "asc",
  }
}

function systemPlaylists(): Playlist[] {
  const now = new Date().toISOString()
  const make = (id: string, name: string, kind: Playlist["kind"]): Playlist => ({
    id,
    name,
    trackIds: [],
    createdAt: now,
    updatedAt: now,
    system: true,
    kind,
  })
  return [
    make("sys:all", "All Songs", "all"),
    make("sys:favourites", "Favourites", "favourites"),
    make("sys:albums", "Albums", "albums"),
    make("sys:artists", "Artists", "artists"),
  ]
}

let state: PersistedState | null = null
let writeQueued: Promise<void> = Promise.resolve()

export function stateFilePath(): string {
  return path.join(app.getPath("userData"), "titan-player.json")
}

export async function loadState(): Promise<PersistedState> {
  if (state) return state

  const defaults: PersistedState = {
    version: SCHEMA_VERSION,
    settings: defaultSettings(),
    playlists: systemPlaylists(),
    favourites: [],
    hidden: [],
  }

  try {
    const raw = await fs.readFile(stateFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    state = {
      version: SCHEMA_VERSION,
      // Merge so a settings file written by an older build still loads.
      settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
      playlists: Array.isArray(parsed.playlists) && parsed.playlists.length > 0
        ? parsed.playlists
        : defaults.playlists,
      favourites: Array.isArray(parsed.favourites) ? parsed.favourites : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    }
  } catch {
    // First run, or the file is unreadable. Either way the defaults are usable.
    state = defaults
    await flush()
  }

  return state
}

/** Serialise writes so concurrent callers cannot interleave and corrupt the file. */
export async function flush(): Promise<void> {
  const snapshot = state
  if (!snapshot) return
  const file = stateFilePath()

  writeQueued = writeQueued.then(async () => {
    const tmp = `${file}.tmp`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8")
    // Rename is atomic on the same volume, so a crash cannot truncate the state.
    await fs.rename(tmp, file)
  }).catch((err) => {
    console.error("[store] failed to persist state:", err)
  })

  return writeQueued
}

export function getSettings(): LibrarySettings {
  return state?.settings ?? defaultSettings()
}

export async function updateSettings(patch: Partial<LibrarySettings>): Promise<LibrarySettings> {
  const current = await loadState()
  current.settings = { ...current.settings, ...patch }
  await flush()
  return current.settings
}

export function getPlaylists(): Playlist[] {
  return state?.playlists ?? systemPlaylists()
}

export function getPlaylist(id: string): Playlist | undefined {
  return getPlaylists().find((p) => p.id === id)
}

export async function createPlaylist(name: string): Promise<Playlist> {
  const current = await loadState()
  const now = new Date().toISOString()
  const playlist: Playlist = {
    id: randomUUID(),
    name: name.trim() || "New Playlist",
    trackIds: [],
    createdAt: now,
    updatedAt: now,
    system: false,
    kind: "custom",
  }
  current.playlists.push(playlist)
  await flush()
  return playlist
}

export async function updatePlaylist(
  id: string,
  patch: Partial<Pick<Playlist, "name" | "trackIds">>,
): Promise<Playlist | undefined> {
  const current = await loadState()
  const playlist = current.playlists.find((p) => p.id === id)
  if (!playlist) return undefined
  if (playlist.system && patch.name !== undefined) return playlist
  if (patch.name !== undefined) playlist.name = patch.name
  if (patch.trackIds !== undefined) {
    // De-duplicate while preserving the caller's ordering, which is meaningful.
    playlist.trackIds = [...new Set(patch.trackIds)]
  }
  playlist.updatedAt = new Date().toISOString()
  await flush()
  return playlist
}

export async function deletePlaylist(id: string): Promise<boolean> {
  const current = await loadState()
  const index = current.playlists.findIndex((p) => p.id === id)
  if (index === -1) return false
  if (current.playlists[index].system) return false
  current.playlists.splice(index, 1)
  await flush()
  return true
}

/** Drop tracks that no longer exist on disk from every playlist. */
export async function prunePlaylists(validIds: Set<string>): Promise<void> {
  const current = await loadState()
  let changed = false
  for (const playlist of current.playlists) {
    const before = playlist.trackIds.length
    playlist.trackIds = playlist.trackIds.filter((id) => validIds.has(id))
    if (playlist.trackIds.length !== before) changed = true
  }
  current.favourites = current.favourites.filter((id) => validIds.has(id))
  current.hidden = current.hidden.filter((id) => validIds.has(id))
  if (changed) await flush()
}

export function getFavourites(): string[] {
  return state?.favourites ?? []
}

export async function toggleFavourite(trackId: string): Promise<string[]> {
  const current = await loadState()
  const index = current.favourites.indexOf(trackId)
  if (index === -1) current.favourites.push(trackId)
  else current.favourites.splice(index, 1)
  await flush()
  return current.favourites
}

export function getHidden(): string[] {
  return state?.hidden ?? []
}

export async function setHidden(trackId: string, hidden: boolean): Promise<string[]> {
  const current = await loadState()
  const index = current.hidden.indexOf(trackId)
  if (hidden && index === -1) current.hidden.push(trackId)
  if (!hidden && index !== -1) current.hidden.splice(index, 1)
  await flush()
  return current.hidden
}
