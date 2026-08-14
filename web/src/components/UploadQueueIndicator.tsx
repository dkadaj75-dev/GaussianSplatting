/**
 * The shell's standing reminder that photos are still owed to the server.
 *
 * Uploads outlive the capture page, so without this a user would leave the
 * screen, see nothing anywhere, and reasonably assume their photos are safely
 * on the server when they are still sitting in IndexedDB waiting for signal.
 */

import { Link } from 'react-router-dom';
import { useUploadQueue } from '../hooks/useUploadQueue';
import { AlertIcon, OfflineIcon, UploadIcon } from './icons';

export function UploadQueueIndicator({ className = '' }: { className?: string }) {
  const queue = useUploadQueue();
  if (queue.pending === 0 && queue.failed === 0) return null;

  const percent = Math.round(queue.progress * 100);
  const [Icon, tone, label] = queue.waitingForNetwork
    ? ([OfflineIcon, 'text-warn', `Waiting for Wi-Fi · ${queue.pending}`] as const)
    : queue.pending > 0
      ? ([UploadIcon, 'text-accent', `Uploading ${queue.pending} · ${percent}%`] as const)
      : ([AlertIcon, 'text-danger', `${queue.failed} upload${queue.failed === 1 ? '' : 's'} failed`] as const);

  return (
    <Link
      to="/capture"
      data-testid="queue-indicator"
      aria-label={`Upload queue: ${label}`}
      className={`flex min-h-touch items-center gap-2 rounded-lg px-2 text-[11px] font-medium text-muted transition-colors hover:bg-raised hover:text-content ${className}`}
    >
      <Icon className={`size-4 shrink-0 ${tone}`} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

export default UploadQueueIndicator;
