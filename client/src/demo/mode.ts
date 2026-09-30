/**
 * Whether the interface is running on fixture data.
 *
 * This exists so the whole product can be seen and reviewed without a database, a
 * chain connection or a wallet. It is deliberately awkward to leave on by
 * accident:
 *
 * - it is off unless `VITE_DEMO_DATA` is exactly `true`;
 * - it refuses to run in a production build, so a real deployment cannot serve
 *   fixture data to a real consumer even if the flag is set.
 *
 * The second point is the only thing standing between a mistake here and a public
 * site answering a regulator's question with invented batches, so it is the part
 * that must not be weakened. A build that wants fixtures has to say so in as many
 * words.
 */

const FLAG = import.meta.env["VITE_DEMO_DATA"];

function requested(): boolean {
  return typeof FLAG === "string" && FLAG.trim().toLowerCase() === "true";
}

/** True when the bundle is a production build. */
function isProductionBuild(): boolean {
  return import.meta.env["PROD"] === true || import.meta.env["MODE"] === "production";
}

/**
 * Whether requests are answered from fixtures.
 *
 * A production build always answers from the API. A review build is worth showing,
 * but not on a public deployment where a consumer would take it for the registry.
 */
export function isDemoDataEnabled(): boolean {
  if (!requested()) return false;
  if (isProductionBuild() && !isExplicitlyAllowedInProduction()) return false;
  return true;
}

/**
 * The one way to run fixtures in a production build: an explicit acknowledgement
 * that the deployment is itself a demonstration.
 */
function isExplicitlyAllowedInProduction(): boolean {
  const acknowledgement = import.meta.env["VITE_DEMO_DATA_ACK"];
  return typeof acknowledgement === "string" && acknowledgement === "I understand this is not real data";
}

/** Why fixtures are off, for anyone debugging a build that is not behaving. */
export function demoDataStatus(): { enabled: boolean; reason: string } {
  if (!requested()) {
    return { enabled: false, reason: "VITE_DEMO_DATA is not set to true" };
  }
  if (isProductionBuild() && !isExplicitlyAllowedInProduction()) {
    return {
      enabled: false,
      reason:
        "a production build answers from the API; set VITE_DEMO_DATA_ACK to override",
    };
  }
  return { enabled: true, reason: "serving fixture data" };
}
