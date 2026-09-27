/**
 * Finishes the database writes for transactions that Solana confirmed but whose
 * off-chain write did not land.
 *
 * This is the recovery path the design promises. When the cluster accepts a
 * transaction and the subsequent database write fails, the API does not report
 * success and does not leave the record looking unconfirmed: it writes a
 * reconciliation task holding the transaction signature and the intended write.
 * This script replays those writes from the chain, so a participant is never
 * asked to sign the same action twice.
 *
 * Usage:
 *   npm run reconcile                 list what is outstanding
 *   npm run reconcile -- --dry-run    show what would be done, change nothing
 *   npm run reconcile -- --apply      complete the outstanding writes
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { getChainClient } from "../src/services/solana/chainClientRegistry.js";
import {
  NotificationModel,
  ProductMetadataModel,
  ReconciliationTaskModel,
  TransferModel,
  UserModel,
} from "../src/models/index.js";
import { newId } from "../src/lib/crypto.js";
import { logger } from "../src/lib/logger.js";

const apply = process.argv.includes("--apply");

interface Outcome {
  taskId: string;
  action: string;
  productId: string;
  signature: string;
  result: "completed" | "already-final" | "failed" | "skipped";
  detail: string;
}

async function completeProductRegistration(
  task: { productId: string; transactionSignature: string; intent: Record<string, unknown> },
  chain: ReturnType<typeof getChainClient>
): Promise<Pick<Outcome, "result" | "detail">> {
  const onChain = await chain.fetchProduct(task.productId);
  if (onChain === null) {
    return {
      result: "failed",
      detail: "The on-chain account for this batch cannot be read.",
    };
  }
  const stored = await ProductMetadataModel.findOne({ productId: task.productId });
  if (stored === null) {
    return {
      result: "failed",
      detail: "The off-chain batch record no longer exists; it was probably removed.",
    };
  }
  if (stored.chainState === "CONFIRMED") {
    return { result: "already-final", detail: "The batch is already recorded as confirmed." };
  }
  if (onChain.offChainDataHash !== stored.dataHash) {
    return {
      result: "failed",
      detail: `The anchored hash (${onChain.offChainDataHash}) does not match the stored hash (${stored.dataHash}). This needs a human.`,
    };
  }

  stored.onChainTxHash = task.transactionSignature;
  stored.onChainDataHash = onChain.offChainDataHash;
  stored.onChainAddress = onChain.product;
  stored.onChainRegisteredAt = new Date(onChain.registeredAt * 1000);
  stored.onChainTransferCount = onChain.transferCount;
  stored.status = onChain.status;
  stored.chainState = "CONFIRMED";
  stored.chainError = null;
  await stored.save();
  return { result: "completed", detail: "The batch record now reflects the confirmed chain state." };
}

async function completeTransfer(
  task: { productId: string; transactionSignature: string; intent: Record<string, unknown> },
  chain: ReturnType<typeof getChainClient>
): Promise<Pick<Outcome, "result" | "detail">> {
  const onChain = await chain.fetchProduct(task.productId);
  if (onChain === null) {
    return { result: "failed", detail: "The on-chain account for this batch cannot be read." };
  }
  const transfer = await TransferModel.findOne({
    transactionSignature: task.transactionSignature,
  });
  const transferId = task.intent["transferId"];
  const record =
    transfer ??
    (typeof transferId === "string"
      ? await TransferModel.findOne({ transferId })
      : null);
  if (record === null) {
    return { result: "failed", detail: "The transfer record no longer exists." };
  }
  if (record.status === "COMPLETED") {
    return { result: "already-final", detail: "The transfer is already recorded as completed." };
  }
  if (onChain.owner !== record.toWallet) {
    return {
      result: "failed",
      detail: `The on-chain owner is ${onChain.owner}, not the recorded recipient ${record.toWallet}. This needs a human.`,
    };
  }

  record.status = "COMPLETED";
  record.transactionSignature = task.transactionSignature;
  record.confirmedAt = new Date();
  record.resultingStatus = onChain.status;
  record.failureReason = null;
  await record.save();

  const product = await ProductMetadataModel.findOne({ productId: task.productId });
  if (product !== null) {
    const previousOwner = product.ownerWallet;
    product.ownerWallet = onChain.owner;
    product.status = onChain.status;
    product.onChainTransferCount = onChain.transferCount;
    await product.save();
    await NotificationModel.insertMany(
      [
        { toWallet: record.toWallet, kind: "TRANSFER_RECEIVED", title: `You now own batch ${record.productId}` },
        { toWallet: previousOwner, kind: "TRANSFER_SENT", title: `Batch ${record.productId} transferred` },
      ].map((entry) => ({
        notificationId: newId(),
        recipientWallet: entry.toWallet,
        kind: entry.kind as "TRANSFER_RECEIVED" | "TRANSFER_SENT",
        title: entry.title,
        body: `Reconciled after transaction ${task.transactionSignature} was confirmed.`,
        productId: record.productId,
        linkPath: `/app/products/${record.productId}`,
      }))
    );
  }
  return { result: "completed", detail: "The transfer now reflects the confirmed chain state." };
}

async function completeStatusUpdate(
  task: { productId: string; transactionSignature: string; intent: Record<string, unknown> },
  chain: ReturnType<typeof getChainClient>
): Promise<Pick<Outcome, "result" | "detail">> {
  const onChain = await chain.fetchProduct(task.productId);
  if (onChain === null) {
    return { result: "failed", detail: "The on-chain account for this batch cannot be read." };
  }
  const expected = task.intent["status"];
  if (typeof expected === "string" && expected !== onChain.status) {
    return {
      result: "failed",
      detail: `The chain holds ${onChain.status}, not the ${expected} the transaction was meant to set.`,
    };
  }
  const product = await ProductMetadataModel.findOne({ productId: task.productId });
  if (product === null) {
    return { result: "failed", detail: "The batch record no longer exists." };
  }
  if (product.status === onChain.status && product.chainState === "CONFIRMED") {
    return { result: "already-final", detail: "The batch already reflects the chain." };
  }
  product.status = onChain.status;
  product.chainState = "CONFIRMED";
  product.chainError = null;
  await product.save();
  return { result: "completed", detail: "The batch stage now matches the chain." };
}

async function main(): Promise<void> {
  await connectDatabase();
  const chain = getChainClient();

  const health = await chain.health();
  if (!health.reachable) {
    process.stderr.write(
      "Solana is not reachable, so nothing can be reconciled. Check SOLANA_RPC_URL and try again.\n"
    );
    await disconnectDatabase();
    process.exit(1);
  }

  const tasks = await ReconciliationTaskModel.find({ status: "PENDING" }).sort({
    createdAt: 1,
  });

  if (tasks.length === 0) {
    process.stdout.write("Nothing is outstanding: every confirmed transaction is recorded.\n");
    await disconnectDatabase();
    return;
  }

  process.stdout.write(
    `${tasks.length} confirmed transaction(s) are not fully recorded in the database.\n\n`
  );

  const outcomes: Outcome[] = [];
  for (const task of tasks) {
    const base = {
      taskId: task.taskId,
      action: task.action,
      productId: task.productId,
      signature: task.transactionSignature,
    };
    let result: Pick<Outcome, "result" | "detail">;
    try {
      switch (task.action) {
        case "COMPLETE_PRODUCT_REGISTRATION":
          result = await completeProductRegistration(task, chain);
          break;
        case "COMPLETE_TRANSFER":
          result = await completeTransfer(task, chain);
          break;
        case "COMPLETE_STATUS_UPDATE":
        case "COMPLETE_PROCESSING_LOG":
        case "COMPLETE_TRANSPORT_LOG":
        case "COMPLETE_CERTIFICATE":
          result = await completeStatusUpdate(task, chain);
          break;
        default:
          result = { result: "skipped", detail: "No handler for this action." };
      }
    } catch (error) {
      result = {
        result: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    outcomes.push({ ...base, ...result });
    process.stdout.write(
      `  ${result.result.padEnd(14)} ${task.action} ${task.productId}\n` +
        `                 ${task.transactionSignature}\n` +
        `                 ${result.detail}\n\n`
    );

    if (apply && result.result === "completed") {
      task.status = "RESOLVED";
      task.resolvedAt = new Date();
      task.attempts += 1;
      await task.save();
    }
  }

  const regulators = await UserModel.find({
    role: "REGULATOR",
    status: "ACTIVE",
    onChainRegistered: true,
  })
    .select({ walletAddress: 1 })
    .lean();

  const failed = outcomes.filter((entry) => entry.result === "failed");
  if (apply && failed.length > 0 && regulators.length > 0) {
    await NotificationModel.insertMany(
      regulators.map((regulator) => ({
        notificationId: newId(),
        recipientWallet: regulator.walletAddress,
        kind: "RECONCILIATION_REQUIRED" as const,
        title: "A confirmed transaction still needs a human",
        body: `${failed.length} reconciliation task(s) could not be completed automatically and need review.`,
        productId: failed[0]?.productId ?? null,
        linkPath: "/app/operations/reconciliation",
      }))
    );
  }

  const completed = outcomes.filter((entry) => entry.result === "completed").length;
  const alreadyFinal = outcomes.filter((entry) => entry.result === "already-final").length;
  process.stdout.write(
    `${completed} completed, ${alreadyFinal} already final, ${failed.length} needing a human.\n`
  );

  if (!apply) {
    process.stdout.write(
      "\nNothing was changed. Re-run with --apply to complete the outstanding writes.\n"
    );
  }

  logger.info(
    { tasks: tasks.length, completed, alreadyFinal, failed: failed.length, apply },
    "reconciliation run finished"
  );
  await disconnectDatabase();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Reconciliation could not run: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
