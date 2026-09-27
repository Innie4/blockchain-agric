import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getNotifications, markNotificationRead } from "../../api/endpoints";
import type { AppNotification, NotificationFeed } from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Spinner,
  Table,
  type TableColumn,
} from "../../components/ui/Index";
import { humaniseKey } from "./appData";
import { DatedTimeValue } from "./appUi";

/**
 * Everything the registry has told this participant.
 *
 * Read and unread are both written out in words rather than left to a colour or
 * a background tint, because a notification list is read quickly and a reader
 * has to be able to tell at a glance which messages still need attention.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly feed: NotificationFeed };

function columnsFor(
  pendingId: string | null,
  onOpen: (notification: AppNotification) => void,
): readonly TableColumn<AppNotification>[] {
  return [
    {
      key: "state",
      header: "State",
      isRowHeader: true,
      render: (row) => (
        <span className="stack stack--tight">
          <Badge
            tone={row.readAt === null ? "info" : "neutral"}
            icon={row.readAt === null ? "bell" : "check"}
          >
            {row.readAt === null ? "Unread" : "Read"}
          </Badge>
          <span className="table__secondary">{humaniseKey(row.kind)}</span>
        </span>
      ),
    },
    {
      key: "title",
      header: "Notification",
      render: (row) => (
        <span className="stack stack--tight">
          <span>{row.title}</span>
          <span className="table__secondary">{row.body}</span>
        </span>
      ),
    },
    {
      key: "when",
      header: "When",
      render: (row) => <DatedTimeValue value={row.createdAt} />,
    },
    {
      key: "action",
      header: "Action",
      render: (row) => (
        <span className="cluster cluster--tight">
          {row.linkPath === null ? null : (
            <Link
              className="btn btn--quiet btn--sm"
              to={row.linkPath}
              onClick={() => { onOpen(row); }}
            >
              <Icon name="externalLink" size={14} />
              Open
              <span className="visually-hidden"> {row.title}</span>
            </Link>
          )}
          {row.readAt === null ? (
            <Button
              variant="secondary"
              size="sm"
              loading={pendingId === row.notificationId}
              loadingLabel="Marking this notification as read"
              onClick={() => { onOpen(row); }}
            >
              Mark as read
            </Button>
          ) : (
            <span className="text-xs text-muted nowrap">Read</span>
          )}
        </span>
      ),
    },
  ];
}

export default function NotificationsPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    getNotifications(controller.signal)
      .then((feed) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", feed });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt]);

  /**
   * Opening a notification and reading it are the same act here, so both the
   * link and the button mark it as read. The server records who read what, and
   * a regulator reviewing an audit trail should see that accurately.
   */
  const open = useCallback((notification: AppNotification) => {
    if (notification.readAt !== null) return;
    setPendingId(notification.notificationId);
    void markNotificationRead(notification.notificationId)
      .then(() => {
        setState((current) =>
          current.phase !== "ready"
            ? current
            : {
                phase: "ready",
                feed: {
                  unreadCount: Math.max(0, current.feed.unreadCount - 1),
                  notifications: current.feed.notifications.map((item) =>
                    item.notificationId === notification.notificationId
                      ? { ...item, readAt: new Date().toISOString() }
                      : item,
                  ),
                },
              },
        );
      })
      .catch(() => {
        // Reading is not a change the participant depends on, so a failure here
        // is left to the next refresh rather than interrupting the reader.
      })
      .finally(() => {
        setPendingId(null);
      });
  }, []);

  const heading = (
    <PageHeader
      title="Notifications"
      description="The messages the registry has sent to your wallet, newest first."
      actions={
        <Button variant="secondary" onClick={load}>
          <Icon name="refresh" size={16} />
          Refresh
        </Button>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading your notifications" rows={6} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="Your notifications could not be read"
          retryLabel="Read them again"
          onRetry={load}
          actions={
            <Link className="btn btn--secondary" to="/app/activity">
              See your activity instead
            </Link>
          }
        />
      </div>
    );
  }

  const { notifications, unreadCount } = state.feed;

  return (
    <div className="page">
      {heading}

      <p className="text-sm text-secondary" aria-live="polite">
        {unreadCount === 0
          ? "No unread notifications. Everything the registry has sent you has been read."
          : `${unreadCount} of ${notifications.length} shown ${
              unreadCount === 1 ? "is" : "are"
            } still unread.`}
        {pendingId === null ? null : (
          <>
            {" "}
            <Spinner size={14} label="Marking a notification as read" /> Marking one as read.
          </>
        )}
      </p>

      {notifications.length === 0 ? (
        <EmptyState
          icon="bell"
          title="You have no notifications"
          description="The registry sends a message when a batch is sent to you, when a transfer completes, when a batch you registered is checked and found not to match, or when a record needs a regulator's attention. Until one of those happens there is nothing to read."
          action={
            <Link className="btn btn--secondary" to="/app/activity">
              <Icon name="flag" size={16} />
              See your activity instead
            </Link>
          }
        />
      ) : (
        <Panel title="Your notifications">
          <Table
            caption="Notifications sent to your wallet, newest first"
            columns={columnsFor(pendingId, open)}
            rows={notifications}
            rowKey={(row) => row.notificationId}
            emptyState={
              <EmptyState
                icon="bell"
                title="You have no notifications"
                description="Nothing has been sent to your wallet yet."
              />
            }
          />
          <p className="text-xs text-muted">
            Opening a notification, or pressing mark as read, records that you have seen it. The
            message stays in the list, so there is still a record of what you were told and when.
          </p>
        </Panel>
      )}
    </div>
  );
}
