import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getNotifications, markNotificationRead } from "../../api/endpoints";
import type { AppNotification } from "../../api/types";
import { useAuth } from "../../context/AuthContext";
import { formatDateTime } from "../../lib/format";
import { useMenuDismiss } from "../../lib/useMenuDismiss";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";

const POLL_INTERVAL_MS = 60_000;

/**
 * The unread notice.
 *
 * Polling rather than a socket is a deliberate choice: notices here are few and
 * a minute old is soon enough, and a long-lived connection would add a moving
 * part for no benefit. The list is only fetched while somebody is signed in.
 */
export function NotificationBell() {
  const { status } = useAuth();
  const isAuthenticated = status === "authenticated";
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const menuRef = useMenuDismiss<HTMLDivElement>(isOpen, () => setIsOpen(false));

  const close = useCallback(() => setIsOpen(false), []);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!isAuthenticated) return;
      setIsLoading(true);
      try {
        const feed = await getNotifications(signal);
        setNotifications(feed.notifications);
        setUnreadCount(feed.unreadCount);
        setHasFailed(false);
      } catch {
        if (signal?.aborted === true) return;
        setHasFailed(true);
      } finally {
        if (signal?.aborted !== true) setIsLoading(false);
      }
    },
    [isAuthenticated],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    const abort = new AbortController();
    void load(abort.signal);
    const timer = window.setInterval(() => {
      void load(abort.signal);
    }, POLL_INTERVAL_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [isAuthenticated, load]);

  if (!isAuthenticated) return null;

  async function markAsRead(notification: AppNotification): Promise<void> {
    setPendingIds((current) => new Set(current).add(notification.notificationId));
    try {
      const result = await markNotificationRead(notification.notificationId);
      setNotifications((current) =>
        current.map((item) =>
          item.notificationId === notification.notificationId ? result.notification : item,
        ),
      );
      setUnreadCount((current) => Math.max(0, current - 1));
    } catch {
      setHasFailed(true);
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(notification.notificationId);
        return next;
      });
    }
  }

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="bell"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) void load();
        }}
      >
        <Icon name="bell" size={18} />
        <span className="visually-hidden">
          {unreadCount === 0
            ? "Notifications, none unread"
            : `Notifications, ${unreadCount} unread`}
        </span>
        {unreadCount > 0 ? (
          <span className="bell__count" aria-hidden="true">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="menu" role="menu" aria-label="Notifications">
          <div className="menu__header">
            <span>Notifications</span>
            {isLoading ? <Spinner size={14} label="Refreshing notifications" /> : null}
          </div>

          {notifications.length === 0 ? (
            <div className="menu__item">
              <p className="text-sm text-secondary">
                {hasFailed
                  ? "The notification list could not be loaded. Close this and try again."
                  : "There is nothing to report."}
              </p>
            </div>
          ) : (
            <ul className="menu__list">
              {notifications.map((notification) => {
                const isUnread = notification.readAt === null;
                const isPending = pendingIds.has(notification.notificationId);
                return (
                  <li
                    className={["menu__item", isUnread ? "menu__item--unread" : null]
                      .filter((value): value is string => value !== null)
                      .join(" ")}
                    key={notification.notificationId}
                  >
                    <span className="menu__item-title">
                      <span>{notification.title}</span>
                      <span className="menu__item-time">
                        {formatDateTime(notification.createdAt)}
                      </span>
                    </span>
                    <span className="menu__item-body">{notification.body}</span>
                    <span className="cluster cluster--tight">
                      {notification.linkPath === null ? null : (
                        <Link
                          className="btn btn--quiet btn--sm"
                          to={notification.linkPath}
                          onClick={close}
                        >
                          Open
                        </Link>
                      )}
                      {isUnread ? (
                        <button
                          type="button"
                          className="btn btn--quiet btn--sm"
                          disabled={isPending}
                          onClick={() => void markAsRead(notification)}
                        >
                          {isPending ? "Marking as read" : "Mark as read"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted">Read</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="menu__item">
            <Link className="btn btn--secondary btn--sm" to="/app/notifications" onClick={close}>
              See all notifications
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
