import { STATUS_LABELS, type ProductStatus } from "../../api/types";
import { Badge, type BadgeTone } from "./Badge";

const STATUS_TONES: Record<ProductStatus, BadgeTone> = {
  REGISTERED: "info",
  IN_PROCESSING: "earth",
  PROCESSED: "earth",
  IN_TRANSIT: "info",
  AT_RETAILER: "neutral",
  LISTED: "success",
  SOLD: "neutral",
  FLAGGED: "danger",
};

/** What each stage means for the batch, in the words a participant uses. */
const STATUS_DESCRIPTIONS: Record<ProductStatus, string> = {
  REGISTERED: "Recorded by the farmer and anchored on the blockchain.",
  IN_PROCESSING: "Being handled by a processor.",
  PROCESSED: "Processing is finished; the batch is ready to move.",
  IN_TRANSIT: "On the road with a transporter.",
  AT_RETAILER: "In store with a retailer.",
  LISTED: "On offer to the public.",
  SOLD: "Sold. Its record stays here permanently.",
  FLAGGED: "Withheld by a regulator. It cannot be transferred or sold.",
};

export interface StatusBadgeProps {
  status: ProductStatus;
  /** Also print the explanation, for a page with room for it. */
  showDescription?: boolean;
  className?: string;
}

/**
 * A batch's stage. The label is always written out, and the explanation is
 * available so the colour is never the only thing being said.
 */
export function StatusBadge({
  status,
  showDescription = false,
  className,
}: StatusBadgeProps) {
  const label = STATUS_LABELS[status];
  const description = STATUS_DESCRIPTIONS[status];

  if (!showDescription) {
    return (
      <Badge
        tone={STATUS_TONES[status]}
        className={className}
        title={description}
        icon={status === "FLAGGED" ? "flag" : undefined}
      >
        {label}
      </Badge>
    );
  }

  return (
    <span className={["stack", "stack--tight", className].filter(isPresent).join(" ")}>
      <Badge
        tone={STATUS_TONES[status]}
        icon={status === "FLAGGED" ? "flag" : undefined}
      >
        {label}
      </Badge>
      <span className="text-secondary text-xs">{description}</span>
    </span>
  );
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}
