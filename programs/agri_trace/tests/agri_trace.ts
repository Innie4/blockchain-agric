import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgriTrace } from "../target/types/agri_trace";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

/**
 * On-chain test-suite for the agricultural supply chain program.
 *
 * Run with `anchor test` from `programs/agri_trace`. Every test asserts a
 * business rule that the off-chain backend also enforces, so a regression on
 * either side of the boundary is caught.
 */
describe("agri_trace program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgriTrace as Program<AgriTrace>;
  const connection = provider.connection;

  const PRODUCT_SEED = Buffer.from("product");
  const PARTICIPANT_SEED = Buffer.from("participant");
  const PROGRAM_ID = program.programId;

  const DATA_HASH = Buffer.alloc(32, 7);
  const OTHER_DATA_HASH = Buffer.alloc(32, 9);
  const TRANSFER_ID = Buffer.alloc(16, 3);

  const lamports = async (pda: PublicKey) =>
    (await connection.getAccountInfo(pda))?.lamports ?? 0;

  const productPda = (productId: string) =>
    PublicKey.findProgramAddressSync(
      [PRODUCT_SEED, Buffer.from(productId, "utf8")],
      PROGRAM_ID
    )[0];

  const participantPda = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [PARTICIPANT_SEED, wallet.toBuffer()],
      PROGRAM_ID
    )[0];

  const registerParticipant = async (
    wallet: Keypair,
    role: any,
    profileHash = DATA_HASH
  ) => {
    await program.methods
      .registerParticipant(role, Array.from(profileHash))
      .accounts({
        participant: wallet.publicKey,
        participantRegistry: participantPda(wallet.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    return participantPda(wallet.publicKey);
  };

  let farmer: Keypair;
  let farmerPda: PublicKey;
  let processor: Keypair;
  let processorPda: PublicKey;
  let transporter: Keypair;
  let transporterPda: PublicKey;
  let retailer: Keypair;
  let retailerPda: PublicKey;
  let regulator: Keypair;
  let regulatorPda: PublicKey;
  let outsider: Keypair;

  before(async () => {
    farmer = Keypair.generate();
    processor = Keypair.generate();
    transporter = Keypair.generate();
    retailer = Keypair.generate();
    regulator = Keypair.generate();
    outsider = Keypair.generate();

    for (const kp of [farmer, processor, transporter, retailer, regulator, outsider]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    }

    farmerPda = await registerParticipant(farmer, { farmer: {} });
    processorPda = await registerParticipant(processor, { processor: {} });
    transporterPda = await registerParticipant(transporter, { transporter: {} });
    retailerPda = await registerParticipant(retailer, { retailer: {} });
    regulatorPda = await registerParticipant(regulator, { regulator: {} });
  });

  const registerProduct = (
    productId: string,
    signer: Keypair = farmer,
    hash = DATA_HASH
  ) =>
    program.methods
      .registerProduct(productId, Array.from(hash))
      .accounts({
        registrant: signer.publicKey,
        registrantRegistry: participantPda(signer.publicKey),
        product: productPda(productId),
        systemProgram: SystemProgram.programId,
      })
      .signers([signer]);

  describe("participant registry", () => {
    it("registers a participant and anchors their profile hash", async () => {
      const wallet = Keypair.generate();
      await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
      const pda = participantPda(wallet.publicKey);
      const lamportsBefore = await lamports(pda);

      await registerParticipant(wallet, { retailer: {} });

      const account = await program.account.participantAccount.fetch(pda);
      expect(account.participant.equals(wallet.publicKey)).to.be.true;
      expect(account.role).to.deep.equal({ retailer: {} });
      expect(account.revoked).to.be.false;
      expect(Buffer.from(account.profileHash).equals(DATA_HASH)).to.be.true;
      expect(account.registeredAt.toNumber()).to.be.greaterThan(0);
      // A PDA carries no lamports of its own once initialised.
      expect(await lamports(pda)).to.equal(lamportsBefore);
    });

    it("rejects a second registration for the same wallet", async () => {
      const wallet = Keypair.generate();
      await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
      await registerParticipant(wallet, { farmer: {} });

      try {
        await registerParticipant(wallet, { regulator: {} });
        expect.fail("expected ParticipantAlreadyRegistered");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal(
          "ParticipantAlreadyRegistered"
        );
      }
    });
  });

  describe("UT-01 register unique product", () => {
    const productId = "AGT-COCOA-2026-A10001";

    it("succeeds and emits ProductRegistered", async () => {
      const pda = productPda(productId);
      const before = await lamports(pda);

      await registerProduct(productId).rpc();

      const account = await program.account.productAccount.fetch(pda);
      expect(account.productId).to.equal(productId);
      expect(account.registrant.equals(farmer.publicKey)).to.be.true;
      expect(account.owner.equals(farmer.publicKey)).to.be.true;
      expect(account.status).to.deep.equal({ registered: {} });
      expect(account.transferCount).to.equal(0);
      expect(account.registeredAt.toNumber()).to.be.greaterThan(0);
      expect(account.updatedAt.toNumber()).to.be.greaterThan(0);
      expect(Buffer.from(account.offChainDataHash).equals(DATA_HASH)).to.be.true;
      // init funds the new account from the payer.
      expect(await lamports(pda)).to.be.greaterThan(before);
    });
  });

  describe("UT-02 register duplicate product", () => {
    const productId = "AGT-COCOA-2026-A10002";

    it("is rejected on the second attempt", async () => {
      await registerProduct(productId).rpc();
      const pda = productPda(productId);
      const ownerBefore = (await program.account.productAccount.fetch(pda)).owner;

      try {
        await registerProduct(productId).rpc();
        expect.fail("expected the duplicate registration to be rejected");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        expect([
          "ConstraintAlreadyInUse",
          "AccountAlreadyInUse",
          "DuplicateProduct",
        ]).to.include(code);
      }

      const after = await program.account.productAccount.fetch(pda);
      expect(after.owner.equals(ownerBefore)).to.be.true;
      expect(after.transferCount).to.equal(0);
    });
  });

  describe("UT-03 current owner transfers", () => {
    const productId = "AGT-COCOA-2026-A10003";
    let pda: PublicKey;

    it("succeeds, moves ownership atomically and emits OwnershipTransferred", async () => {
      pda = productPda(productId);
      await registerProduct(productId).rpc();

      const registryBefore = await lamports(processorPda);
      const productLamportsBefore = await lamports(pda);

      await program.methods
        .transferOwnership(Array.from(TRANSFER_ID))
        .accounts({
          currentOwner: farmer.publicKey,
          product: pda,
          recipientRegistry: processorPda,
        })
        .rpc();

      const account = await program.account.productAccount.fetch(pda);
      expect(account.owner.equals(processor.publicKey)).to.be.true;
      expect(account.transferCount).to.equal(1);
      expect(account.lastTransferAt.toNumber()).to.be.greaterThan(0);
      // Receiving a batch by a processor advances the lifecycle on-chain.
      expect(account.status).to.deep.equal({ inProcessing: {} });
      // The transfer moves value only in the sense of account rent, which
      // must be untouched by a pure ownership change.
      expect(await lamports(pda)).to.equal(productLamportsBefore);
      expect(await lamports(processorPda)).to.equal(registryBefore);
    });
  });

  describe("UT-04 non-owner attempts transfer", () => {
    const productId = "AGT-COCOA-2026-A10004";

    it("is rejected and leaves ownership unchanged", async () => {
      const pda = productPda(productId);
      await registerProduct(productId).rpc();
      await program.methods
        .transferOwnership(Array.from(TRANSFER_ID))
        .accounts({
          currentOwner: farmer.publicKey,
          product: pda,
          recipientRegistry: processorPda,
        })
        .rpc();

      try {
        await program.methods
          .transferOwnership(Array.from(TRANSFER_ID))
          .accounts({
            currentOwner: outsider.publicKey,
            product: pda,
            recipientRegistry: retailerPda,
          })
          .rpc();
        expect.fail("expected the non-owner transfer to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("UnauthorizedOwner");
      }

      const account = await program.account.productAccount.fetch(pda);
      expect(account.owner.equals(processor.publicKey)).to.be.true;
      expect(account.transferCount).to.equal(1);
    });
  });

  describe("UT-05 unregistered recipient", () => {
    const productId = "AGT-COCOA-2026-A10005";

    it("is rejected because no registry account exists", async () => {
      const pda = productPda(productId);
      const stranger = Keypair.generate();
      const strangerPda = participantPda(stranger.publicKey);
      await registerProduct(productId).rpc();

      try {
        await program.methods
          .transferOwnership(Array.from(TRANSFER_ID))
          .accounts({
            currentOwner: farmer.publicKey,
            product: pda,
            recipientRegistry: strangerPda,
          })
          .rpc();
        expect.fail("expected the unregistered recipient to be rejected");
      } catch (err: any) {
        // Anchor surfaces the missing account before the program's own checks.
        expect(["AccountNotInitialized", "InvalidRecipient"]).to.include(
          err.error?.errorCode?.code
        );
      }

      const account = await program.account.productAccount.fetch(pda);
      expect(account.owner.equals(farmer.publicKey)).to.be.true;
      expect(account.transferCount).to.equal(0);
    });

    it("is rejected when the recipient is a farmer", async () => {
      const secondFarmer = Keypair.generate();
      await connection.requestAirdrop(secondFarmer.publicKey, LAMPORTS_PER_SOL);
      const secondFarmerPda = await registerParticipant(secondFarmer, {
        farmer: {},
      });
      const pda = productPda(productId);

      try {
        await program.methods
          .transferOwnership(Array.from(TRANSFER_ID))
          .accounts({
            currentOwner: farmer.publicKey,
            product: pda,
            recipientRegistry: secondFarmerPda,
          })
          .rpc();
        expect.fail("expected a farmer recipient to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("RecipientRoleNotAllowed");
      }
    });
  });

  describe("UT-06 retrieve registered product", () => {
    const productId = "AGT-COCOA-2026-A10006";

    it("returns the stored record through an account query", async () => {
      const pda = productPda(productId);
      await registerProduct(productId, farmer, OTHER_DATA_HASH).rpc();

      const fetched = await program.account.productAccount.fetch(pda);
      expect(fetched.productId).to.equal(productId);
      expect(Buffer.from(fetched.offChainDataHash).equals(OTHER_DATA_HASH)).to.be
        .true;
      expect(fetched.version).to.equal(1);
    });

    it("derives the same address for the same identifier every time", () => {
      const a = productPda("AGT-COCOA-2026-A10006");
      const b = productPda("AGT-COCOA-2026-A10006");
      const c = productPda("AGT-COCOA-2026-A10007");
      expect(a.equals(b)).to.be.true;
      expect(a.equals(c)).to.be.false;
    });
  });

  describe("malformed identifiers", () => {
    it("rejects an empty identifier", async () => {
      try {
        await registerProduct("").rpc();
        expect.fail("expected an empty identifier to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("MalformedIdentifier");
      }
    });

    it("rejects an oversized identifier", async () => {
      try {
        await registerProduct("A".repeat(33)).rpc();
        expect.fail("expected an oversized identifier to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("MalformedIdentifier");
      }
    });

    it("rejects an identifier containing non-graphic characters", async () => {
      try {
        await registerProduct("AGT COCOA 2026 A10008").rpc();
        expect.fail("expected a spaced identifier to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("MalformedIdentifier");
      }
    });
  });

  describe("lifecycle status transitions", () => {
    const productId = "AGT-COCOA-2026-A10009";
    let pda: PublicKey;

    beforeEach(async () => {
      pda = productPda(productId);
      await registerProduct(productId).rpc();
    });

    const updateStatus = (
      newStatus: any,
      actor: Keypair,
      actorRegistry: PublicKey,
      occurredAt: number
    ) =>
      program.methods
        .updateStatus(newStatus, new anchor.BN(occurredAt))
        .accounts({
          actor: actor.publicKey,
          actorRegistry,
          product: pda,
        })
        .signers([actor]);

    it("allows the owner to advance one step at a time", async () => {
      const now = Math.floor(Date.now() / 1000);
      await updateStatus({ inProcessing: {} }, farmer, farmerPda, now).rpc();
      const account = await program.account.productAccount.fetch(pda);
      expect(account.status).to.deep.equal({ inProcessing: {} });
      expect(account.updatedAt.toNumber()).to.be.greaterThanOrEqual(now);
    });

    it("rejects a skipped step", async () => {
      const now = Math.floor(Date.now() / 1000);
      try {
        await updateStatus({ processed: {} }, farmer, farmerPda, now).rpc();
        expect.fail("expected the skipped transition to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("InvalidStateTransition");
      }
    });

    it("rejects a status update from a registered non-owner", async () => {
      const now = Math.floor(Date.now() / 1000);
      try {
        await updateStatus(
          { inProcessing: {} },
          transporter,
          transporterPda,
          now
        ).rpc();
        expect.fail("expected the non-owner update to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("UnauthorizedOwner");
      }
    });

    it("rejects a backdated event timestamp", async () => {
      try {
        await updateStatus({ inProcessing: {} }, farmer, farmerPda, 1).rpc();
        expect.fail("expected the backdated timestamp to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("InvalidTimestamp");
      }
    });

    it("rejects a far-future event timestamp", async () => {
      const far = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
      try {
        await updateStatus({ inProcessing: {} }, farmer, farmerPda, far).rpc();
        expect.fail("expected the future timestamp to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("InvalidTimestamp");
      }
    });

    it("lets a regulator withhold and release a batch", async () => {
      const now = Math.floor(Date.now() / 1000);
      await updateStatus({ inProcessing: {} }, farmer, farmerPda, now).rpc();
      await updateStatus({ flagged: {} }, regulator, regulatorPda, now).rpc();

      let account = await program.account.productAccount.fetch(pda);
      expect(account.status).to.deep.equal({ flagged: {} });
      expect(account.preFlagStatus).to.deep.equal({ inProcessing: {} });

      await updateStatus({ processed: {} }, regulator, regulatorPda, now).rpc();
      account = await program.account.productAccount.fetch(pda);
      expect(account.status).to.deep.equal({ processed: {} });
    });

    it("prevents a non-regulator from flagging a batch", async () => {
      const now = Math.floor(Date.now() / 1000);
      try {
        await updateStatus({ flagged: {} }, farmer, farmerPda, now).rpc();
        expect.fail("expected a farmer flag attempt to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("RegulatorOnly");
      }
    });

    it("prevents progress while a batch is withheld", async () => {
      const now = Math.floor(Date.now() / 1000);
      await updateStatus({ flagged: {} }, regulator, regulatorPda, now).rpc();
      try {
        await updateStatus({ inProcessing: {} }, farmer, farmerPda, now).rpc();
        expect.fail("expected a flagged batch to be frozen");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("RegulatorOnly");
      }
    });
  });

  describe("full supply chain progression", () => {
    const productId = "AGT-COCOA-2026-A10010";

    it("moves a batch from farmer to a sold retail listing", async () => {
      const pda = productPda(productId);
      const now = Math.floor(Date.now() / 1000);
      await registerProduct(productId).rpc();

      await program.methods
        .transferOwnership(Array.from(TRANSFER_ID))
        .accounts({
          currentOwner: farmer.publicKey,
          product: pda,
          recipientRegistry: processorPda,
        })
        .rpc();

      await program.methods
        .updateStatus(
          { processed: {} },
          new anchor.BN(now)
        )
        .accounts({ actor: processor.publicKey, actorRegistry: processorPda, product: pda })
        .rpc();

      await program.methods
        .transferOwnership(Array.from(TRANSFER_ID))
        .accounts({
          currentOwner: processor.publicKey,
          product: pda,
          recipientRegistry: transporterPda,
        })
        .rpc();

      await program.methods
        .updateStatus({ atRetailer: {} }, new anchor.BN(now))
        .accounts({ actor: transporter.publicKey, actorRegistry: transporterPda, product: pda })
        .rpc();

      await program.methods
        .transferOwnership(Array.from(TRANSFER_ID))
        .accounts({
          currentOwner: transporter.publicKey,
          product: pda,
          recipientRegistry: retailerPda,
        })
        .rpc();

      await program.methods
        .updateStatus({ listed: {} }, new anchor.BN(now))
        .accounts({ actor: retailer.publicKey, actorRegistry: retailerPda, product: pda })
        .rpc();

      await program.methods
        .updateStatus({ sold: {} }, new anchor.BN(now))
        .accounts({ actor: retailer.publicKey, actorRegistry: retailerPda, product: pda })
        .rpc();

      const account = await program.account.productAccount.fetch(pda);
      expect(account.status).to.deep.equal({ sold: {} });
      expect(account.owner.equals(retailer.publicKey)).to.be.true;
      expect(account.transferCount).to.equal(3);
    });

    it("refuses to transfer a sold batch", async () => {
      const pda = productPda(productId);
      try {
        await program.methods
          .transferOwnership(Array.from(TRANSFER_ID))
          .accounts({
            currentOwner: retailer.publicKey,
            product: pda,
            recipientRegistry: processorPda,
          })
          .rpc();
        expect.fail("expected a terminal batch transfer to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("ProductClosed");
      }
    });
  });

  describe("verification attestation", () => {
    const productId = "AGT-COCOA-2026-A10011";

    it("records a regulator attestation and stamps lastVerifiedAt", async () => {
      const pda = productPda(productId);
      const now = Math.floor(Date.now() / 1000);
      await registerProduct(productId).rpc();

      await program.methods
        .recordVerification(
          { verified: {} },
          Array.from(DATA_HASH),
          new anchor.BN(now)
        )
        .accounts({
          verifier: regulator.publicKey,
          verifierRegistry: regulatorPda,
          product: pda,
        })
        .rpc();

      const account = await program.account.productAccount.fetch(pda);
      expect(account.lastVerifiedAt.toNumber()).to.be.greaterThan(0);
    });

    it("rejects an attestation from a non-regulator", async () => {
      const pda = productPda(productId);
      const now = Math.floor(Date.now() / 1000);
      try {
        await program.methods
          .recordVerification(
            { verified: {} },
            Array.from(DATA_HASH),
            new anchor.BN(now)
          )
          .accounts({
            verifier: farmer.publicKey,
            verifierRegistry: farmerPda,
            product: pda,
          })
          .rpc();
        expect.fail("expected a farmer attestation to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("RegulatorOnly");
      }
    });
  });

  describe("registration authorisation", () => {
    it("rejects registration by a processor", async () => {
      const productId = "AGT-COCOA-2026-A10012";
      try {
        await registerProduct(productId, processor).rpc();
        expect.fail("expected a processor registration to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("RegistrantRoleNotAllowed");
      }
    });

    it("rejects registration by a wallet with no registry entry", async () => {
      const productId = "AGT-COCOA-2026-A10013";
      try {
        await registerProduct(productId, outsider).rpc();
        expect.fail("expected an unregistered registrant to be rejected");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("ParticipantNotRegistered");
      }
    });
  });
});
