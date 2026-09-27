import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getProduct, listCertificates } from "../../../api/endpoints";
import {
  CHAIN_STATE_LABELS,
  VERIFICATION_RESULT_LABELS,
  type Certificate,
  type MediaRef,
  type ProductDetailResponse,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState, NotFoundState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  QrCode,
  StatusBadge,
  Table,
  type TableColumn,
} from "../../../components/ui/Index";
import { formatDateTime, formatQuantity, truncateHash } from "../../../lib/format";
import { useMediaObjectUrl } from "../../../lib/media";
import { verificationUrl } from "../../../lib/solana";
import {
  chainStateFromWire,
  compareHashes,
  isNotFound,
  useCopyToClipboard,
  useProductId,
} from "../appData";
import {
  AddressValue,
  ChainStateBadge,
  DatedValue,
  DatedTimeValue,
  SignatureValue,
} from "../appUi";

/**
 * One batch, in full.
 *
 * A participant is entitled to see more here than the public page shows: the
 * owner and registrant wallets, the certificate documents, and the photographs
 * themselves. That is why every action on this screen is driven by the
 * permission flags the server returned rather than by a rule written here: the
 * page cannot offer an action the server would refuse.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: ProductDetailResponse };

type CertificateState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly certificates: readonly Certificate[] };

/* ------------------------------------------------------------------ *
 * Photographs
 * ------------------------------------------------------------------ */

function ProductImage({ image }: { image: MediaRef }) {
  const { url, isLoading, hasFailed } = useMediaObjectUrl(image.mediaId);
  const caption = image.caption.trim().length > 0 ? image.caption.trim() : image.fileName;

  return (
    <figure className="stack stack--tight">
      {url === null ? (
        <div className="card__body text-sm text-secondary">
          {hasFailed
            ? "The photograph could not be fetched from the records service."
            : isLoading
              ? "Fetching the photograph."
              : "No photograph is available."}
        </div>
      ) : (
        <img
          src={url}
          alt={caption}
          width={240}
          height={180}
          style={{ width: "100%", height: "auto", borderRadius: "var(--radius-md)" }}
        />
      )}
      <figcaption className="text-xs text-secondary">{caption}</figcaption>
    </figure>
  );
}

const CERTIFICATE_COLUMNS: readonly TableColumn<Certificate>[] = [
  {
    key: "certificate",
    header: "Certificate",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <span>{row.certificateType}</span>
        <span className="table__secondary">
          {row.issuingBody} · {row.referenceNumber}
        </span>
      </span>
    ),
  },
  { key: "issued", header: "Issued", render: (row) => <DatedValue value={row.issuedOn} /> },
  { key: "expires", header: "Expires", render: (row) => <DatedValue value={row.expiresOn} /> },
  {
    key: "hash",
    header: "Fingerprint",
    render: (row) => (
      <span className="hash" title={row.dataHash}>
        {truncateHash(row.dataHash)}
      </span>
    ),
  },
];

/* ------------------------------------------------------------------ *
 * The actions this participant may take
 * ------------------------------------------------------------------ */

interface Action {
  to: string;
  label: string;
  icon: ReactNode;
  hint: string;
}

function RoleActions({
  response,
  productId,
}: {
  response: ProductDetailResponse;
  productId: string;
}) {
  const encoded = encodeURIComponent(productId);
  const actions: Action[] = [];

  if (response.canTransfer) {
    actions.push({
      to: `/app/products/${encoded}/transfer`,
      label: "Hand this batch on",
      icon: <Icon name="truck" size={16} />,
      hint: "Prepare a transfer, then sign it in your wallet.",
    });
  }
  if (response.canRecordProcessing) {
    actions.push({
      to: `/app/products/${encoded}/processing`,
      label: "Record processing",
      icon: <Icon name="clipboard" size={16} />,
      hint: "Sorting, drying, fermenting or anything else done to the batch.",
    });
  }
  if (response.canRecordTransport) {
    actions.push({
      to: `/app/products/${encoded}/transport`,
      label: "Record a journey",
      icon: <Icon name="truck" size={16} />,
      hint: "Where the batch travelled, when, and how.",
    });
  }
  if (response.canListForSale) {
    actions.push({
      to: `/app/products/${encoded}/sale`,
      label: "Set the listing",
      icon: <Icon name="store" size={16} />,
      hint: "Asking price and whether the batch is on offer.",
    });
  }

  if (actions.length === 0) {
    return (
      <div className="notice notice--info">
        <Icon name="info" size={18} />
        <div className="notice__body">
          <p className="notice__title">There is nothing for you to record against this batch</p>
          <p className="text-sm text-secondary">
            {response.isOwner
              ? "You hold this batch, but your role does not cover any of the lifecycle records a holder can make. A processor records processing, a transporter records journeys and a retailer sets the listing."
              : response.isRegistrant
                ? "You registered this batch, so you can see everything about it and answer for the details you entered, but you no longer hold it, so there is nothing to record."
                : "You hold neither this batch nor its registration, so this is a read-only view. You can still open its history and check it against the blockchain."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid--2">
      {actions.map((action) => (
        <Link className="card" key={action.to} to={action.to}>
          <span className="card__body stack stack--tight">
            <span className="card__title">
              <span className="cluster cluster--tight">
                {action.icon}
                {action.label}
              </span>
            </span>
            <span className="text-sm text-secondary">{action.hint}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ProductDetailPage() {
  const productId = useProductId();
  const copy = useCopyToClipboard();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [certificates, setCertificates] = useState<CertificateState>({ phase: "loading" });

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });

    getProduct(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, productId]);

  useEffect(() => {
    if (productId === null || state.phase !== "ready") return;
    const controller = new AbortController();
    setCertificates({ phase: "loading" });

    listCertificates(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setCertificates({ phase: "ready", certificates: response.certificates });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCertificates({ phase: "ready", certificates: [] });
      });

    return () => controller.abort();
  }, [attempt, productId, state.phase]);

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Batch" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is nothing to open."
          action={
            <Link className="btn btn--primary" to="/app/products">
              Go to the batch list
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <PageHeader
      title={`Batch ${productId}`}
      description={
        state.phase === "ready"
          ? "Everything the registry holds for this batch, and what you are able to do with it."
          : "Reading this batch from the registry."
      }
      breadcrumbs={[{ label: "Batches", to: "/app/products" }, { label: productId }]}
      actions={
        <div className="cluster cluster--tight">
          <Link className="btn btn--secondary" to={`/app/products/${encodeURIComponent(productId)}/history`}>
            <Icon name="flag" size={16} />
            History
          </Link>
          <Link className="btn btn--secondary" to={`/app/products/${encodeURIComponent(productId)}/verify`}>
            <Icon name="shield" size={16} />
            Check it
          </Link>
        </div>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label={`Reading batch ${productId}`} rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    if (isNotFound(state.error)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title={`No batch is registered as ${productId}`}
            description="The registry holds no record under this identifier. Check it against the packaging, or search by crop and farm instead."
            action={
              <div className="cluster cluster--tight">
                <Link className="btn btn--primary" to="/app/products">
                  Go to the batch list
                </Link>
                <Link className="btn btn--secondary" to="/search">
                  Search the registry
                </Link>
              </div>
            }
          />
        </div>
      );
    }
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title={`Batch ${productId} could not be read`}
          retryLabel="Read it again"
          onRetry={retry}
        />
      </div>
    );
  }

  const { product, verificationUrl: verificationLink } = state.response;
  const chainState = chainStateFromWire(product.chainState);
  const isConfirmed = chainState === "CONFIRMED";
  const agreement = compareHashes(product.onChainDataHash, product.dataHash);
  const link = verificationLink.length > 0 ? verificationLink : verificationUrl(product.productId);

  return (
    <div className="page">
      {heading}

      <Panel
        tone={isConfirmed ? "default" : "warning"}
        title={isConfirmed ? "This batch is on the blockchain" : "This batch is not yet on the blockchain"}
        actions={
          <span className="cluster cluster--tight">
            <StatusBadge status={product.status} showDescription={false} />
            <ChainStateBadge state={chainState} />
          </span>
        }
      >
        <div className="stack">
          {isConfirmed ? (
            <p className="measure text-secondary">
              The details below were hashed and anchored on Solana when the batch was registered, and
              the server has read the on-chain account back to check it. Nobody can change what is
              written there.
            </p>
          ) : (
            <>
              <p className="measure text-secondary">
                The details of this batch are saved in the records service, but the blockchain copy
                does not exist yet, so it is not yet a registered batch and a buyer checking it from
                the public page will be told there is no record. The current state is{" "}
                <strong>{CHAIN_STATE_LABELS[chainState].toLowerCase()}</strong>.
              </p>
              {chainState === "AWAITING_SIGNATURE" || chainState === "SUBMITTED" ? (
                <p className="measure text-secondary">
                  The registration was prepared and is waiting for a wallet signature. Open the
                  register-a-batch page again and prepare it once more if the signature was declined
                  or the transaction expired, or abandon the draft if the batch was never harvested.
                </p>
              ) : null}
              {chainState === "NEEDS_RECONCILIATION" ? (
                <p className="measure text-secondary">
                  Solana confirmed this transaction but the matching record could not be written at
                  the time. A regulator can finish it from the reconciliation queue. Nothing has
                  been lost.
                </p>
              ) : null}
              {chainState === "CANCELLED" ? (
                <p className="measure text-secondary">
                  This draft was abandoned before it was signed. Its details are no longer held as a
                  pending registration, and nothing was written to the blockchain.
                </p>
              ) : null}
            </>
          )}

          <div className="cluster">
            <StatusBadge status={product.status} showDescription />
          </div>
        </div>
      </Panel>

      <Panel title="What this batch is">
        <dl className="definition-list">
          <dt>Crop or product</dt>
          <dd>{product.cropType}</dd>

          <dt>Quantity</dt>
          <dd>{formatQuantity(product.quantity, product.unit)}</dd>

          <dt>Farm location</dt>
          <dd>
            {product.farmLocation}
            <span className="table__secondary">
              Recorded as it was entered at registration. Precise coordinates are never published.
            </span>
          </dd>

          <dt>Harvest date</dt>
          <dd>
            <DatedValue value={product.harvestDate} />
          </dd>

          <dt>Registered on the blockchain</dt>
          <dd>
            <DatedValue value={product.onChainRegisteredAt} />
            <span className="table__secondary">
              Saved in the records service on <DatedTimeValue value={product.createdAt} />.
            </span>
          </dd>

          <dt>Description</dt>
          <dd>{product.description.length > 0 ? product.description : "No description was recorded."}</dd>

          <dt>Additional notes</dt>
          <dd>
            {product.additionalNotes.length > 0
              ? product.additionalNotes
              : "No additional notes were recorded."}
          </dd>
        </dl>
      </Panel>

      <Panel title="Who holds it">
        <dl className="definition-list">
          <dt>Current owner</dt>
          <dd>
            <AddressValue address={product.ownerWallet} onCopy={copy} what="owner wallet address" />
            <span className="table__secondary">
              Only this wallet can transfer the batch onward. A transfer confirmed on the
              blockchain changes it, and nothing else does.
            </span>
          </dd>

          <dt>Registered by</dt>
          <dd>
            <AddressValue
              address={product.registeredByWallet}
              onCopy={copy}
              what="registrant wallet address"
            />
            <span className="table__secondary">
              A {product.registrantRole.replace(/_/g, " ").toLowerCase()}, at the time of
              registration. Being the registrant does not confer ownership.
            </span>
          </dd>

          <dt>Recorded transfers</dt>
          <dd>
            {product.onChainTransferCount}
            <span className="table__secondary">
              The number the on-chain account reports, not the number of attempts. A transfer that
              was never signed is not counted.
            </span>
          </dd>
        </dl>
      </Panel>

      <Panel
        title="The anchored fingerprint"
        actions={
          <Badge
            tone={agreement === "match" ? "success" : agreement === "mismatch" ? "danger" : "neutral"}
            icon={agreement === "match" ? "check" : agreement === "mismatch" ? "alertTriangle" : "info"}
          >
            {agreement === "match"
              ? "The stored details still match"
              : agreement === "mismatch"
                ? "The stored details no longer match"
                : "There is nothing to compare yet"}
          </Badge>
        }
      >
        <div className="stack">
          <p className="measure text-secondary">
            The fingerprint below is a SHA-256 of the batch details as they were at registration. It
            was written to the blockchain, so it cannot be edited. If the details held here are
            changed afterwards, recomputing the fingerprint no longer produces the same value, and
            the change is detectable by anyone.
          </p>
          <dl className="definition-list">
            <dt>On the blockchain</dt>
            <dd>
              {product.onChainDataHash === null ? (
                <span className="text-secondary">
                  Nothing is anchored, because the registration has not been confirmed.
                </span>
              ) : (
                <span className="hash">{product.onChainDataHash}</span>
              )}
            </dd>

            <dt>Held in the records</dt>
            <dd>
              <span className="hash">{product.dataHash}</span>
            </dd>

            <dt>They agree</dt>
            <dd>
              {agreement === "match"
                ? "Yes. The details held here are the details that were anchored."
                : agreement === "mismatch"
                  ? "No. Treat this batch as unverified, do not rely on its details, and report it to a regulator."
                  : "Not applicable while nothing is anchored."}
            </dd>

            <dt>Registration transaction</dt>
            <dd>
              <SignatureValue signature={product.onChainTxHash} />
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title="Photographs">
        {product.images.length === 0 ? (
          <EmptyState
            icon="fileText"
            title="No photographs are attached to this batch"
            description="A farmer or regulator can attach photographs. They are held off the blockchain, but each file's hash is recorded so one cannot later be swapped for another."
          />
        ) : (
          <div className="grid grid--3">
            {product.images.map((image) => (
              <ProductImage key={image.mediaId} image={image} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Certificates"
        actions={
          certificates.phase === "loading" ? (
            <span className="text-xs text-secondary">Reading certificates</span>
          ) : null
        }
      >
        {certificates.phase === "loading" ? (
          <LoadingState label="Reading the certificates attached to this batch" rows={3} />
        ) : certificates.certificates.length === 0 ? (
          <EmptyState
            icon="fileText"
            title="No certificates are attached to this batch"
            description={`This batch has ${product.certificates.length} certificate file${
              product.certificates.length === 1 ? "" : "s"
            } held against it, but none has been described with an issuing body, type and reference number yet. A processor or regulator can attach one.`}
          />
        ) : (
          <Table
            caption="Certificates attached to this batch"
            columns={CERTIFICATE_COLUMNS}
            rows={certificates.certificates}
            rowKey={(row) => row.certificateId}
            compact
            emptyState={
              <EmptyState
                icon="fileText"
                title="No certificates are attached to this batch"
                description="Nothing has been described as a certificate."
              />
            }
          />
        )}
      </Panel>

      <Panel title="What you can do with this batch">
        <RoleActions response={state.response} productId={product.productId} />
      </Panel>

      <Panel title="The code buyers can scan">
        <div className="stack">
          <p className="measure text-secondary">
            Anyone who scans this, or opens the link, reaches the public verification page for this
            batch. It needs no account and no wallet, and it compares the stored details against the
            fingerprint anchored on the blockchain.
          </p>
          <p className="cluster cluster--tight">
            <span className="hash">{link}</span>
            <Button variant="secondary" size="sm" onClick={() => { copy(link, "Verification link"); }}>
              <Icon name="clipboard" size={16} />
              Copy the link
            </Button>
          </p>
          <QrCode
            productId={product.productId}
            payload={link}
            caption="Print this on the packaging or on a tag tied to the batch."
          />
        </div>
      </Panel>

      <Panel title="Check and history">
        <div className="stack">
          <p className="measure text-secondary">
            The history is the full sequence of events: registration, transfers, processing,
            journeys, listing and every check anyone has made. Checking the batch runs the comparison
            against the blockchain again, from inside your account, and records that you did it.
          </p>
          <div className="cluster">
            <Link
              className="btn btn--primary"
              to={`/app/products/${encodeURIComponent(product.productId)}/verify`}
            >
              <Icon name="shield" size={16} />
              Check this batch
            </Link>
            <Link
              className="btn btn--secondary"
              to={`/app/products/${encodeURIComponent(product.productId)}/history`}
            >
              <Icon name="flag" size={16} />
              Read the full history
            </Link>
          </div>
        </div>
      </Panel>

      <p className="measure text-xs text-muted">
        Last check recorded for this batch:{" "}
        {product.lastVerifiedAt === null ? "never" : formatDateTime(product.lastVerifiedAt)}, with
        the result {VERIFICATION_RESULT_LABELS[product.lastVerificationResult].toLowerCase()}. A
        regulator sees every check across the network on the compliance dashboard.
      </p>
    </div>
  );
}
