import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  getHealth,
  prepareParticipantRegistration,
  type ParticipantRegistrationConfirmed,
  submitParticipantRegistration,
  updateProfile,
} from "../../api/endpoints";
import { fieldErrorFor, messageForError } from "../../api/errors";
import {
  ROLE_LABELS,
  type Prepared,
  type RuntimeConfig,
  type UpdateProfileInput,
  type User,
} from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { LoadingState, TransactionState } from "../../components/states";
import {
  Badge,
  Button,
  Field,
  Icon,
  Panel,
  TextInput,
} from "../../components/ui/Index";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useWalletState } from "../../context/WalletContext";
import { CLUSTER_LABEL, SOLANA_CLUSTER } from "../../lib/solana";
import { describeRole, isEmailLike, useCopyToClipboard } from "./appData";
import { AddressValue, DatedValue, SignatureValue } from "./appUi";
import { useChainAction } from "./useChainAction";

/**
 * The account settings: contact details, on-chain participant registration, the
 * wallet, and the configuration this build is running against.
 *
 * Nothing on this page is editable that would change the meaning of an existing
 * record. A role is decided deliberately and a wallet address is an identity, so
 * both are shown and left alone.
 */

const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;

interface EditForm {
  fullName: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  state: string;
  organisation: string;
}

function formFrom(user: User): EditForm {
  return {
    fullName: user.fullName,
    contactEmail: user.contactInfo.email,
    contactPhone: user.contactInfo.phone,
    address: user.contactInfo.address,
    state: user.contactInfo.state,
    organisation: user.organisation,
  };
}

/** Reads the public runtime configuration the server publishes. */
function readRuntimeConfig(runtime: Record<string, unknown>): RuntimeConfig | null {
  const network = runtime["solanaNetwork"];
  const programId = runtime["solanaProgramId"];
  const clusterLabel = runtime["solanaClusterLabel"];
  const commitment = runtime["solanaCommitment"];
  const maxBytes = runtime["uploadMaxFileBytes"];
  if (typeof network !== "string" || typeof programId !== "string") return null;

  return {
    solanaNetwork: network,
    solanaClusterLabel: typeof clusterLabel === "string" ? clusterLabel : network,
    solanaProgramId: programId,
    solanaCommitment: typeof commitment === "string" ? commitment : "confirmed",
    uploadMaxFileBytes:
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : FALLBACK_MAX_FILE_BYTES,
  };
}

type SaveState =
  | { readonly phase: "idle" }
  | { readonly phase: "saving" }
  | { readonly phase: "failed"; readonly error: unknown };

/* ------------------------------------------------------------------ *
 * Contact details
 * ------------------------------------------------------------------ */

function ProfileForm({ user }: { user: User }) {
  const { refresh } = useAuth();
  const { push } = useToast();
  const [form, setForm] = useState<EditForm>(() => formFrom(user));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [state, setState] = useState<SaveState>({ phase: "idle" });

  useEffect(() => {
    setForm(formFrom(user));
  }, [user]);

  function update<K extends keyof EditForm>(key: K, value: EditForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found: Record<string, string | undefined> = {};
    if (form.fullName.trim().length < 2) {
      found["fullName"] = "Enter your full name, so a counterparty knows who they are dealing with.";
    }
    if (form.contactEmail.trim().length > 0 && !isEmailLike(form.contactEmail)) {
      found["contactEmail"] = "Enter a valid email address, or leave the field blank.";
    }
    if (form.contactPhone.trim().length > 0 && form.contactPhone.trim().length < 7) {
      found["contactPhone"] = "Enter a phone number, or leave the field blank.";
    }
    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) {
      setState({ phase: "idle" });
      return;
    }

    const input: UpdateProfileInput = {
      fullName: form.fullName.trim(),
      contactEmail: form.contactEmail.trim(),
      contactPhone: form.contactPhone.trim(),
      address: form.address.trim(),
      state: form.state.trim(),
      organisation: form.organisation.trim(),
    };

    setState({ phase: "saving" });
    void updateProfile(input)
      .then(() => {
        setState({ phase: "idle" });
        push({ tone: "success", title: "Your details were saved" });
        void refresh();
      })
      .catch((error: unknown) => {
        setState({ phase: "failed", error });
        setErrors({
          fullName: fieldErrorFor(error, "fullName"),
          contactEmail: fieldErrorFor(error, "contactEmail"),
          contactPhone: fieldErrorFor(error, "contactPhone"),
          address: fieldErrorFor(error, "address"),
          state: fieldErrorFor(error, "state"),
          organisation: fieldErrorFor(error, "organisation"),
        });
      });
  }

  const isSaving = state.phase === "saving";

  return (
    <form onSubmit={submit} noValidate className="stack">
      {state.phase === "failed" ? (
        <p className="text-sm text-danger" role="alert">
          {messageForError(state.error)} Nothing has been changed. Correct the fields below and try
          again.
        </p>
      ) : null}

      <Field
        id="settings-full-name"
        label="Full name"
        required
        error={errors["fullName"]}
        hint="Shown to the participants you trade with, and to a regulator."
      >
        <TextInput
          name="fullName"
          value={form.fullName}
          autoComplete="name"
          maxLength={160}
          onChange={(event) => { update("fullName", event.target.value); }}
        />
      </Field>

      <Field
        id="settings-email"
        label="Email address"
        optional
        error={errors["contactEmail"]}
        hint="Used for notifications about your batches. Never published on the public record."
      >
        <TextInput
          name="contactEmail"
          type="email"
          value={form.contactEmail}
          autoComplete="email"
          maxLength={200}
          onChange={(event) => { update("contactEmail", event.target.value); }}
        />
      </Field>

      <Field id="settings-phone" label="Phone number" optional error={errors["contactPhone"]}>
        <TextInput
          name="contactPhone"
          type="tel"
          value={form.contactPhone}
          autoComplete="tel"
          maxLength={40}
          onChange={(event) => { update("contactPhone", event.target.value); }}
        />
      </Field>

      <Field
        id="settings-organisation"
        label="Organisation"
        optional
        error={errors["organisation"]}
        hint="Your farm, cooperative, company or depot. Shown to counterparties."
      >
        <TextInput
          name="organisation"
          value={form.organisation}
          autoComplete="organization"
          maxLength={200}
          onChange={(event) => { update("organisation", event.target.value); }}
        />
      </Field>

      <Field id="settings-address" label="Address" optional error={errors["address"]}>
        <TextInput
          name="address"
          value={form.address}
          autoComplete="street-address"
          maxLength={400}
          onChange={(event) => { update("address", event.target.value); }}
        />
      </Field>

      <Field
        id="settings-state"
        label="State or region"
        optional
        error={errors["state"]}
        hint="The state your business operates from. Used to group reports by origin."
      >
        <TextInput
          name="state"
          value={form.state}
          autoComplete="address-level1"
          maxLength={120}
          onChange={(event) => { update("state", event.target.value); }}
        />
      </Field>

      <div className="cluster">
        <Button type="submit" variant="primary" loading={isSaving} loadingLabel="Saving your details">
          <Icon name="check" size={16} />
          Save my details
        </Button>
        <Button
          variant="quiet"
          disabled={isSaving}
          onClick={() => {
            setForm(formFrom(user));
            setErrors({});
          }}
        >
          Discard my changes
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * On-chain participant registration
 * ------------------------------------------------------------------ */

function ParticipantRegistration({ user }: { user: User }) {
  const { refresh } = useAuth();
  const { push } = useToast();
  const copy = useCopyToClipboard();

  const action = useChainAction<Prepared, ParticipantRegistrationConfirmed>({
    prepare: async () => {
      const response = await prepareParticipantRegistration({
        role: user.role,
        fullName: user.fullName,
        contactEmail: user.contactInfo.email,
        contactPhone: user.contactInfo.phone,
        organisation: user.organisation,
      });
      return { prepared: response.prepared, record: response.prepared };
    },
    submit: async ({ signedTransaction }) => submitParticipantRegistration(signedTransaction),
    signatureOf: (result) => result.transactionSignature,
    onConfirmed: () => {
      void refresh();
      push({
        tone: "success",
        title: "Your wallet is registered on the blockchain",
        message: "The participant record and a fingerprint of your details are now permanent.",
      });
    },
  });

  if (user.onChainRegistered) {
    return (
      <div className="stack">
        <div className="notice notice--success">
          <Icon name="check" size={18} />
          <div className="notice__body">
            <p className="notice__title">This wallet is registered on the blockchain</p>
            <p className="text-sm text-secondary">
              The participant entry and the fingerprint of your details were written once and cannot
              be edited or withdrawn. If your name or organisation has changed, update the details
              above: the records service holds the current values, while the fingerprint on the
              blockchain continues to describe the entry as it was made.
            </p>
          </div>
        </div>
        <dl className="definition-list">
          <dt>Registration transaction</dt>
          <dd>
            <SignatureValue signature={user.onChainRegistrationTx} />
          </dd>
          <dt>Anchored profile fingerprint</dt>
          <dd>
            {user.profileHash === null || user.profileHash.length === 0 ? (
              <span className="text-secondary">No fingerprint was returned for this account.</span>
            ) : (
              <span className="hash">{user.profileHash}</span>
            )}
          </dd>
          <dt>Registered on</dt>
          <dd>
            <DatedValue value={user.registrationDate} />
          </dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="notice notice--warning">
        <Icon name="warning" size={18} />
        <div className="notice__body">
          <p className="notice__title">This wallet is not yet registered on the blockchain</p>
          <p className="text-sm text-secondary">
            Until it is, you cannot register a batch of your own and no participant can hand one to
            you. Registration writes your wallet, role and a fingerprint of your details to the
            blockchain, permanently and irreversibly. Read the values below before you sign, because
            they cannot be changed afterwards.
          </p>
        </div>
      </div>

      <dl className="definition-list">
        <dt>Role to register</dt>
        <dd>
          {ROLE_LABELS[user.role]}
          <span className="table__secondary">
            Shown as it will be written on the blockchain. Only an administrator can change a
            participant&rsquo;s role, and only by revoking this entry and registering a new one, so
            make sure it is right.
          </span>
        </dd>
        <dt>Name to register</dt>
        <dd>{user.fullName}</dd>
        <dt>Organisation to register</dt>
        <dd>{user.organisation.length > 0 ? user.organisation : "None"}</dd>
        <dt>Contact to register</dt>
        <dd>
          {user.contactInfo.email || "No email"} · {user.contactInfo.phone || "No phone number"}
        </dd>
        <dt>Wallet to register</dt>
        <dd>
          <AddressValue address={user.walletAddress} onCopy={copy} what="wallet address" />
        </dd>
      </dl>

      <p className="measure text-sm text-secondary">{describeRole(user.role)}</p>

      <TransactionState
        phase={action.phase}
        description={action.prepared?.description ?? null}
        prepared={action.prepared}
        signature={action.signature}
        slot={action.slot}
        error={action.error}
        onPrepare={action.run}
        onSign={action.sign}
        onRetry={action.retry}
        onCancel={action.cancel}
        prepareLabel="Prepare the registration"
        signLabel="Sign in my wallet"
        retryLabel="Prepare again"
        cancelLabel="Start again"
      >
        {action.phase === "confirmed" ? (
          <div className="cluster">
            <Button variant="primary" onClick={action.reset}>
              <Icon name="check" size={16} />
              Finished
            </Button>
            <Button variant="secondary" onClick={action.run}>
              <Icon name="refresh" size={16} />
              Read the state again
            </Button>
          </div>
        ) : null}
      </TransactionState>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { user, status, signOut } = useAuth();
  const { disconnect, publicKey, walletName, clusterLabel } = useWalletState();
  const { push } = useToast();
  const navigate = useNavigate();
  const copy = useCopyToClipboard();

  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getHealth(controller.signal)
      .then((health) => {
        if (controller.signal.aborted) return;
        setConfig(readRuntimeConfig(health.runtime));
        setConfigFailed(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setConfigFailed(true);
      });
    return () => controller.abort();
  }, []);

  const disconnectWallet = useCallback(() => {
    setIsDisconnecting(true);
    void disconnect()
      .then(() => {
        push({ tone: "info", title: "The wallet was disconnected" });
      })
      .catch((error: unknown) => {
        push({
          tone: "warning",
          title: "The wallet did not confirm the disconnect",
          message: messageForError(error),
        });
      })
      .finally(() => setIsDisconnecting(false));
  }, [disconnect, push]);

  const signOutEverywhere = useCallback(() => {
    void signOut()
      .then(() => {
        push({ tone: "info", title: "You are signed out" });
        navigate("/", { replace: true });
      })
      .catch(() => {
        // `signOut` clears the session locally whatever the server says, so the
        // reader is returned to the public pages either way.
        navigate("/", { replace: true });
      });
  }, [navigate, push, signOut]);

  if (status === "loading" || user === null) {
    return (
      <div className="page">
        <PageHeader title="Settings" description="Reading your account settings." />
        <LoadingState label="Reading your account settings" rows={6} />
      </div>
    );
  }

  const isConsumer = user.role === "CONSUMER";

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Your contact details, your on-chain participant registration, this browser's wallet, and the configuration this build is running against."
      />

      <Panel title="Your details">
        {isConsumer ? (
          <div className="stack">
            <p className="measure text-secondary">
              A consumer account holds no participant details, so there is nothing to edit here. A
              consumer checks batches and signs nothing.
            </p>
            <p className="measure text-secondary">
              If you are a farmer, processor, transporter, retailer or regulator, your details are
              what a counterparty sees when you hand them a batch, so they are worth keeping
              accurate.
            </p>
          </div>
        ) : (
          <ProfileForm user={user} />
        )}
      </Panel>

      <Panel
        title="On-chain participant registration"
        actions={
          user.onChainRegistered ? (
            <Badge tone="success" icon="check">
              Registered
            </Badge>
          ) : (
            <Badge tone="warning" icon="warning">
              Not registered
            </Badge>
          )
        }
      >
        {isConsumer ? (
          <p className="measure text-secondary">
            A consumer is not an on-chain registry role, so there is nothing to register. A consumer
            wallet never appears as a participant, a batch owner or a recipient.
          </p>
        ) : (
          <ParticipantRegistration user={user} />
        )}
      </Panel>

      <Panel title="This browser's wallet">
        <div className="stack">
          <p className="measure text-secondary">
            Disconnecting asks the wallet extension to forget this page. Your batches, transfers and
            registrations stay exactly where they are: they are on the blockchain and in the
            registry, not in the browser. You can reconnect the same wallet at any time and will
            see all of it.
          </p>
          <dl className="definition-list">
            <dt>Wallet</dt>
            <dd>{walletName ?? "No wallet connected"}</dd>
            <dt>Connected address</dt>
            <dd>
              <AddressValue address={publicKey} onCopy={copy} what="wallet address" />
            </dd>
            <dt>Network this build reads</dt>
            <dd>{clusterLabel}</dd>
          </dl>
          <div className="cluster">
            <Button
              variant="secondary"
              loading={isDisconnecting}
              loadingLabel="Asking the wallet to disconnect"
              onClick={disconnectWallet}
              disabled={publicKey === null}
            >
              <Icon name="x" size={16} />
              Disconnect wallet
            </Button>
            <p className="text-xs text-muted">
              Disconnecting does not sign you out of this application.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Signing out">
        <div className="stack">
          <p className="measure text-secondary">
            Signing out ends the session this browser holds with the server. The session cookie is
            cleared, so this device is no longer identified as you. Nothing recorded against your
            wallet is affected: your batches stay registered, your transfers stay transferred, and
            reconnecting the same wallet shows all of it again.
          </p>
          <p className="text-sm text-secondary">
            Disconnecting the wallet above and signing out are separate acts. Most people want both,
            in that order.
          </p>
          <div className="cluster">
            <Button variant="danger" onClick={signOutEverywhere}>
              <Icon name="x" size={16} />
              Sign out of this application
            </Button>
            <p className="text-xs text-muted">You will be returned to the public pages.</p>
          </div>
        </div>
      </Panel>

      <Panel title="Configuration this build is running against">
        <div className="stack">
          <p className="measure text-secondary">
            These are the values this deployment was built and deployed with. They are configuration,
            not something a participant sets: changing any of them would point the application at a
            different chain, a different program or a different records service, so none of them can
            be edited from this page.
          </p>

          {configFailed ? (
            <p className="text-sm text-secondary" role="status">
              The server did not return its runtime configuration, so the values below come from
              what this build was compiled with. Nothing has been changed.
            </p>
          ) : null}

          <dl className="definition-list">
            <dt>Solana cluster</dt>
            <dd>
              {config === null ? CLUSTER_LABEL[SOLANA_CLUSTER] : config.solanaClusterLabel}
              <span className="table__secondary">
                The network every signature and every anchored fingerprint belongs to.
              </span>
            </dd>

            <dt>Cluster identifier</dt>
            <dd>
              <span className="hash">{config === null ? SOLANA_CLUSTER : config.solanaNetwork}</span>
            </dd>

            <dt>Commitment level</dt>
            <dd>
              {config === null ? "As compiled" : config.solanaCommitment}
              <span className="table__secondary">
                How firmly the cluster has to have settled a transaction before it is reported as
                confirmed.
              </span>
            </dd>

            <dt>Supply chain program</dt>
            <dd>
              {config === null ? (
                <span className="text-secondary">
                  Not supplied at build time. Ask an administrator which program this deployment
                  writes to.
                </span>
              ) : (
                <span className="hash">{config.solanaProgramId}</span>
              )}
              <span className="table__secondary">
                The deployed on-chain program that holds the batch records and participant registry.
              </span>
            </dd>

            <dt>Largest accepted upload</dt>
            <dd>
              {config === null
                ? `${Math.round(FALLBACK_MAX_FILE_BYTES / (1024 * 1024))} MB`
                : `${Math.round(config.uploadMaxFileBytes / (1024 * 1024))} MB`}
              <span className="table__secondary">
                Per file, for photographs of a batch and for certificates. Checked in the browser
                before an upload starts.
              </span>
            </dd>
          </dl>
        </div>
      </Panel>

      <p className="text-xs text-muted measure">
        Your role is {ROLE_LABELS[user.role]} and cannot be changed from this page. If it is wrong,
        ask an administrator: a role is part of what the blockchain records about a participant, so
        changing it means a new registration rather than an edit.
      </p>
    </div>
  );
}
