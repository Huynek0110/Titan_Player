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
  /**
   * Absolute path -> ISO timestamp of when the file was first seen.
   *
   * Without this, `addedAt` is stamped at parse time, so every rescan hands
   * every track a brand new date and sorting by "Date added" reshuffles the
   * whole library at random.
   */
  firstSeen: Record<string, string>
}

/**
 * Bumped when the shape of persisted state changes in a way that needs a
 * one-time correction rather than a merge.
 *
 * 2: the default sort became album order, so a library that inherited the old
 *    "title" default would otherwise keep alphabetical order forever and ignore
 *    the disc and track numbers every one of its files carries.
 * 3: the same correction again. Version 2 was consumed by a session that still
 *    had the old renderer, which then wrote "title" back, so a file reading
 *    `version: 2` no longer proved the migration had ever taken effect. Keying
 *    the correction on the version is the only reliable signal available.
 */
const SCHEMA_VERSION = 3

function defaultSettings(): LibrarySettings {
  return {
    musicFolders: [],
    useSystemMusicFolder: true,
    extensions: DEFAULT_EXTENSIONS,
    lastView: "library",
    lastPlaylistId: null,
    volume: 0.8,
    repeat: "off",
    shuffle: false,
    // Album order, not title order. Audio files carry disc and track numbers,
    // and honouring them is what makes a library read the way the artist
    // intended rather than alphabetically.
    sortBy: "album",
    sortDir: "asc",
    // Off by default. An automatic lookup tells a third-party server the artist,
    // title and album of every track played, which is a record of what the user
    // listens to. The app is complete without it, so the choice is made
    // deliberately in Settings rather than discovered after the fact.
    fetchOnlineLyrics: false,
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
    firstSeen: {},
  }

  try {
    const raw = await fs.readFile(stateFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const settings = { ...defaults.settings, ...(parsed.settings ?? {}) }

    /*
     * One-time corrections for state written by an older build. Changing a
     * default is not enough on its own: an existing settings file already
     * carries the old value, so the change would never reach anyone who had
     * run the app before, which is exactly the person complaining that their
     * tracks are in the wrong order.
     */
    if (typeof parsed.version === "number" && parsed.version < SCHEMA_VERSION) {
      settings.sortBy = "album"
      settings.sortDir = "asc"
    }

    state = {
      version: SCHEMA_VERSION,
      // Merge so a settings file written by an older build still loads.
      settings,
      playlists: Array.isArray(parsed.playlists) && parsed.playlists.length > 0
        ? parsed.playlists
        : defaults.playlists,
      favourites: Array.isArray(parsed.favourites) ? parsed.favourites : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      firstSeen:
        parsed.firstSeen && typeof parsed.firstSeen === "object" ? parsed.firstSeen : {},
    }

    // Persist the upgrade so it only ever runs once.
    if ((parsed.version ?? 0) < SCHEMA_VERSION) await flush()
  } catch {
    // First run, or the file is unreadable. Either way the defaults are usable.
    state = defaults
    await flush()
  }

  return state
}

/**
 * Resolve each track's original discovery date and remember the ones we have
 * not seen before. Called after a scan so `addedAt` survives a rescan; without
 * it every track looks newly added and the "Date added" order is meaningless.
 */
export async function resolveFirstSeen(
  tracks: Array<{ path: string; addedAt: string }>,
): Promise<void> {
  const current = await loadState()
  let changed = false
  const now = new Date().toISOString()
  const seen = new Set<string>()

  for (const track of tracks) {
    const key = track.path.toLowerCase()
    seen.add(key)
    const existing = current.firstSeen[key]
    if (existing) {
      track.addedAt = existing
    } else {
      current.firstSeen[key] = track.addedAt || now
      changed = true
    }
  }

  // Forget paths that no longer exist, so the file does not grow forever.
  for (const key of Object.keys(current.firstSeen)) {
    if (!seen.has(key)) {
      delete current.firstSeen[key]
      changed = true
    }
  }

  if (changed) await flush()
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

  // Favourites and hidden were filtered outside the flag, so a prune that only
  // touched those two was computed and then thrown away, reappearing on the
  // next launch.
  const favourites = current.favourites.filter((id) => validIds.has(id))
  if (favourites.length !== current.favourites.length) {
    current.favourites = favourites
    changed = true
  }
  const hidden = current.hidden.filter((id) => validIds.has(id))
  if (hidden.length !== current.hidden.length) {
    current.hidden = hidden
    changed = true
  }

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

/** Hide a track from the library views. */
export async function setHidden(trackId: string, hidden: boolean): Promise<string[]> {
  const current = await loadState()
  const index = current.hidden.indexOf(trackId)
  if (hidden && index === -1) current.hidden.push(trackId)
  if (!hidden && index !== -1) current.hidden.splice(index, 1)
  await flush()
  return current.hidden
}
