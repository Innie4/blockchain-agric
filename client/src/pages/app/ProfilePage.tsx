import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { updateProfile } from "../../api/endpoints";
import { fieldErrorFor, messageForError } from "../../api/errors";
import { ROLE_LABELS, type UpdateProfileInput, type User } from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { LoadingState } from "../../components/states";
import { Badge, Button, Field, Icon, Modal, Panel, TextInput } from "../../components/ui/Index";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { describeProductIdShape, describeRole, isEmailLike, useCopyToClipboard } from "./appData";
import { AddressValue, DatedValue, SignatureValue } from "./appUi";

/**
 * The signed-in participant's own record.
 *
 * This is a reading screen first. Editing is a deliberate act behind a dialog,
 * because a participant's details are anchored into the fingerprint their
 * on-chain registration carries, and a change is worth noticing.
 */

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

type SaveState =
  | { readonly phase: "idle" }
  | { readonly phase: "saving" }
  | { readonly phase: "failed"; readonly error: unknown };

/* ------------------------------------------------------------------ *
 * The edit dialog
 * ------------------------------------------------------------------ */

function EditDetailsDialog({
  user,
  open,
  onClose,
  onSaved,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
  onSaved: (user: User) => void;
}) {
  const { push } = useToast();
  const [form, setForm] = useState<EditForm>(() => formFrom(user));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [state, setState] = useState<SaveState>({ phase: "idle" });

  useEffect(() => {
    if (open) {
      setForm(formFrom(user));
      setErrors({});
      setState({ phase: "idle" });
    }
  }, [open, user]);

  function update<K extends keyof EditForm>(key: K, value: EditForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function validate(): boolean {
    const found: Record<string, string | undefined> = {};
    if (form.fullName.trim().length < 2) {
      found["fullName"] = "Enter your full name, so a counterparty knows who they are dealing with.";
    }
    if (form.contactEmail.trim().length > 0 && !isEmailLike(form.contactEmail)) {
      found["contactEmail"] = "Enter a valid email address, or leave the field blank.";
    }
    if (form.contactPhone.trim().length > 0 && form.contactPhone.trim().length < 7) {
      found["contactPhone"] = "Enter a phone number a colleague can reach you on, or leave it blank.";
    }
    setErrors(found);
    return Object.values(found).every((message) => message === undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!validate()) return;

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
      .then((updated) => {
        setState({ phase: "idle" });
        push({
          tone: "success",
          title: "Your details were saved",
          message:
            "Your details are held in the records service. Changing them does not alter the fingerprint already anchored on the blockchain.",
        });
        onSaved(updated);
        onClose();
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
    <Modal
      open={open}
      onClose={onClose}
      title="Edit your details"
      description="These details are shown to the participants you trade with, and to a regulator. Your role and your wallet address cannot be changed here."
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" form="profile-edit-form" variant="primary" loading={isSaving} loadingLabel="Saving your details">
            <Icon name="check" size={16} />
            Save my details
          </Button>
        </>
      }
    >
      <form id="profile-edit-form" onSubmit={submit} noValidate className="stack">
        {state.phase === "failed" ? (
          <p className="text-sm text-danger" role="alert">
            {messageForError(state.error)} Nothing has been changed. Correct the fields above and
            try again.
          </p>
        ) : null}

        <Field
          id="profile-full-name"
          label="Full name"
          required
          error={errors["fullName"]}
          hint="The name a farmer, processor or retailer sees when you hand them a batch."
        >
          <TextInput
            name="fullName"
            value={form.fullName}
            autoComplete="name"
            maxLength={160}
            onChange={(event) => {
              update("fullName", event.target.value);
            }}
          />
        </Field>

        <Field
          id="profile-email"
          label="Email address"
          optional
          error={errors["contactEmail"]}
          hint="Used for notifications about your batches. It is never published to the public record."
        >
          <TextInput
            name="contactEmail"
            type="email"
            value={form.contactEmail}
            autoComplete="email"
            maxLength={200}
            onChange={(event) => {
              update("contactEmail", event.target.value);
            }}
          />
        </Field>

        <Field
          id="profile-phone"
          label="Phone number"
          optional
          error={errors["contactPhone"]}
        >
          <TextInput
            name="contactPhone"
            type="tel"
            value={form.contactPhone}
            autoComplete="tel"
            maxLength={40}
            onChange={(event) => {
              update("contactPhone", event.target.value);
            }}
          />
        </Field>

        <Field id="profile-organisation" label="Organisation" optional error={errors["organisation"]}>
          <TextInput
            name="organisation"
            value={form.organisation}
            autoComplete="organization"
            maxLength={200}
            onChange={(event) => {
              update("organisation", event.target.value);
            }}
          />
        </Field>

        <Field id="profile-address" label="Address" optional error={errors["address"]}>
          <TextInput
            name="address"
            value={form.address}
            autoComplete="street-address"
            maxLength={400}
            onChange={(event) => {
              update("address", event.target.value);
            }}
          />
        </Field>

        <Field
          id="profile-state"
          label="State or region"
          optional
          error={errors["state"]}
          hint="The state your business operates from, used to group reports by origin."
        >
          <TextInput
            name="state"
            value={form.state}
            autoComplete="address-level1"
            maxLength={120}
            onChange={(event) => {
              update("state", event.target.value);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * A consumer account
 * ------------------------------------------------------------------ */

function ConsumerPanel() {
  return (
    <Panel title="A consumer account holds no participant details">
      <div className="stack">
        <p className="measure text-secondary">
          A consumer buys produce. There is no business to register, no batch to hold and nothing to
          sign, so this account deliberately keeps no name, organisation or address. Checking a
          batch needs no account at all.
        </p>
        <p className="measure text-secondary">
          If you are a farmer, processor, transporter, retailer or regulator, your wallet has to be
          registered on the blockchain before you can record anything. That is a one-off
          registration, and it is what ties a signed record to the business that made it.
        </p>
        <div className="cluster">
          <Link className="btn btn--primary" to="/app/settings">
            <Icon name="shield" size={16} />
            Register as a participant
          </Link>
          <Link className="btn btn--secondary" to="/verify">
            <Icon name="search" size={16} />
            Check a batch
          </Link>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ProfilePage() {
  const { user, status, refresh, needsOnChainRegistration } = useAuth();
  const copy = useCopyToClipboard();
  const [isEditing, setIsEditing] = useState(false);

  const handleSaved = useCallback(() => {
    void refresh();
  }, [refresh]);

  if (status === "loading" || user === null) {
    return (
      <div className="page">
        <PageHeader title="Your participant record" description="Reading the account held for your wallet." />
        <LoadingState label="Reading your participant record" rows={6} />
      </div>
    );
  }

  const isConsumer = user.role === "CONSUMER";

  return (
    <div className="page">
      <PageHeader
        title={isConsumer ? "Your account" : "Your participant record"}
        description={
          isConsumer
            ? "A consumer account, signed in with your wallet."
            : `Signed in as a ${ROLE_LABELS[user.role].toLowerCase()}. This is what the registry holds about you, and what a counterparty sees.`
        }
        actions={
          isConsumer ? undefined : (
            <Button variant="secondary" onClick={() => { setIsEditing(true); }}>
              <Icon name="clipboard" size={16} />
              Edit details
            </Button>
          )
        }
      />

      {isConsumer ? <ConsumerPanel /> : null}

      <Panel
        title="Identity"
        actions={
          <Badge tone={user.status === "ACTIVE" ? "success" : "warning"}>
            {user.status === "ACTIVE" ? "Active account" : `Account ${user.status.toLowerCase()}`}
          </Badge>
        }
      >
        <dl className="definition-list">
          <dt>Full name</dt>
          <dd>{user.fullName.length > 0 ? user.fullName : "No name recorded"}</dd>

          <dt>Role</dt>
          <dd>
            {ROLE_LABELS[user.role]}
            <span className="table__secondary">{describeRole(user.role)}</span>
          </dd>

          <dt>Organisation</dt>
          <dd>{user.organisation.length > 0 ? user.organisation : "None recorded"}</dd>

          <dt>Wallet address</dt>
          <dd>
            <AddressValue address={user.walletAddress} onCopy={copy} what="wallet address" />
            <span className="table__secondary">
              This is your identity here. It is fixed, and it is the address every record you sign
              is recorded against.
            </span>
          </dd>

          <dt>Registered on</dt>
          <dd>
            <DatedValue value={user.registrationDate} />
          </dd>
        </dl>
      </Panel>

      <Panel
        title="On-chain registration"
        actions={
          user.onChainRegistered ? (
            <Badge tone="success" icon="check">
              Registered on the blockchain
            </Badge>
          ) : (
            <Badge tone="warning" icon="warning">
              Not yet registered
            </Badge>
          )
        }
      >
        <div className="stack">
          <p className="measure text-secondary">
            {user.onChainRegistered
              ? "The blockchain holds a participant record for this wallet, together with a fingerprint of the details that were anchored when you registered. Nobody, including an administrator, can change that entry."
              : "The blockchain does not yet hold a participant record for this wallet, so you cannot register a batch and no one can send you one. Registration is one signature, and it is permanent."}
          </p>

          <dl className="definition-list">
            <dt>Registration transaction</dt>
            <dd>
              <SignatureValue signature={user.onChainRegistrationTx} />
            </dd>

            <dt>Anchored profile fingerprint</dt>
            <dd>
              {user.profileHash === null || user.profileHash.length === 0 ? (
                <span className="text-secondary">
                  No fingerprint has been anchored, because the wallet is not registered on the
                  blockchain yet.
                </span>
              ) : (
                <span className="stack stack--tight">
                  <span className="hash" title={user.profileHash}>
                    {user.profileHash}
                  </span>
                  <span className="table__secondary">
                    Computed from your wallet address, name, role and contact details. It is written
                    once, at registration, and can be read by anyone afterwards.
                  </span>
                </span>
              )}
            </dd>
          </dl>

          {needsOnChainRegistration ? (
            <div className="cluster">
              <Link className="btn btn--primary" to="/app/settings">
                <Icon name="shield" size={16} />
                Register this wallet
              </Link>
            </div>
          ) : null}
        </div>
      </Panel>

      {!isConsumer ? (
        <Panel title="Contact details">
          <div className="stack">
            <p className="measure text-secondary">
              A counterparty sees your name, organisation and role so they know who they are dealing
              with. They do not see your phone number, your email address or your home address:
              those are used for your own notifications and for a regulator.
            </p>
            <dl className="definition-list">
              <dt>Email address</dt>
              <dd>{user.contactInfo.email.length > 0 ? user.contactInfo.email : "Not recorded"}</dd>

              <dt>Phone number</dt>
              <dd>{user.contactInfo.phone.length > 0 ? user.contactInfo.phone : "Not recorded"}</dd>

              <dt>Address</dt>
              <dd>{user.contactInfo.address.length > 0 ? user.contactInfo.address : "Not recorded"}</dd>

              <dt>State or region</dt>
              <dd>{user.contactInfo.state.length > 0 ? user.contactInfo.state : "Not recorded"}</dd>
            </dl>
            <div className="cluster">
              <Button variant="secondary" onClick={() => { setIsEditing(true); }}>
                <Icon name="clipboard" size={16} />
                Edit details
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel title="How your details are used">
        <div className="measure stack text-sm text-secondary">
          <p>
            Your wallet address and your role are the two facts any counterparty or regulator is
            shown. Everything else on this page is either private to you or is a fingerprint of the
            public facts.
          </p>
          <p>{describeProductIdShape()}</p>
          <p>
            Your role is never set from this page. It is decided deliberately, and the blockchain
            registry is the authority for it. If the role on this record is wrong, ask an
            administrator to correct it.
          </p>
        </div>
      </Panel>

      {isConsumer ? null : (
        <EditDetailsDialog
          user={user}
          open={isEditing}
          onClose={() => { setIsEditing(false); }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
