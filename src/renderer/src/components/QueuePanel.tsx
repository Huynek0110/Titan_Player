import { useStore } from "../state/store"
import { formatDuration } from "../lib/format"
import Artwork from "./Artwork"
import { Close, Queue, Trash } from "./Icons"
import "./QueuePanel.css"

/** The play queue, as a right-hand drawer over the library. */
export default function QueuePanel() {
  const { queueTracks, queueIndex, showQueue, setShowQueue, jumpTo, removeFromQueue, clearQueue } =
    useStore()

  if (!showQueue) return null

  const upcoming = queueTracks.slice(queueIndex + 1)

  return (
    <aside className="queue glass">
      <header className="queue-head">
        <Queue size={17} />
        <span className="queue-title">Queue</span>
        <span className="queue-count tabular">{queueTracks.length}</span>
        {queueTracks.length > 0 && (
          <button className="icon-btn" onClick={clearQueue} aria-label="Clear queue" title="Clear queue">
            <Trash size={15} />
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => setShowQueue(false)}
          aria-label="Close queue"
        >
          <Close size={16} />
        </button>
      </header>

      <div className="queue-body">
        {queueTracks.length === 0 ? (
          <p className="queue-empty">Nothing queued</p>
        ) : (
          <>
            {queueIndex >= 0 && (
              <>
                <p className="queue-label">Now playing</p>
                <QueueRow
                  track={queueTracks[queueIndex]}
                  index={queueIndex}
                  current
                  onPlay={() => jumpTo(queueIndex)}
                  onRemove={() => removeFromQueue(queueIndex)}
                />
              </>
            )}

            {upcoming.length > 0 && <p className="queue-label">Next up</p>}
            {upcoming.map((track, i) => {
              const index = queueIndex + 1 + i
              return (
                <QueueRow
                  key={track.id}
                  track={track}
                  index={index}
                  onPlay={() => jumpTo(index)}
                  onRemove={() => removeFromQueue(index)}
                />
              )
            })}
          </>
        )}
      </div>
    </aside>
  )
}

function QueueRow({
  track,
  index,
  current = false,
  onPlay,
  onRemove,
}: {
  track: { id: string; title: string; artist: string; duration: number; hasArtwork: boolean }
  index: number
  current?: boolean
  onPlay: () => void
  onRemove: () => void
}) {
  return (
    <div className={`queue-row ${current ? "current" : ""}`}>
      <span className="queue-index tabular">{index + 1}</span>
      <Artwork
        trackId={track.id}
        hasArtwork={track.hasArtwork}
        alt={track.title}
        size={34}
        seed={track.title}
      />
      <button className="queue-text" onDoubleClick={onPlay} onClick={onPlay} title="Play now">
        <span className="truncate">{track.title}</span>
        <span className="truncate queue-sub">{track.artist}</span>
      </button>
      <span className="queue-dur tabular">{formatDuration(track.duration)}</span>
      <button
        className="icon-btn queue-x"
        onClick={onRemove}
        aria-label="Remove from queue"
        title="Remove"
      >
        <Close size={13} />
      </button>
    </div>
  )
}
