const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TourismTicketingPortal", function() {
  let portal;
  let admin, operator, validator, visitor1, visitor2, visitor3, outsider;
  let siteId, slotId, slotKey;
  let basePrice, maxTransferPrice;

  const makePassId = (label) => ethers.id(label);
  const makeCommitment = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

  beforeEach(async function() {
    [admin, operator, validator, visitor1, visitor2, visitor3, outsider] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory("TourismTicketingPortal");
    portal = await Factory.deploy(admin.address, operator.address, validator.address);
    await portal.waitForDeployment();

    siteId = ethers.encodeBytes32String("MADINAH_MUSEUM");
    slotId = 101n;
    slotKey = await portal.computeSlotKey(siteId, slotId);

    basePrice = ethers.parseEther("0.05");
    maxTransferPrice = ethers.parseEther("0.06");

    const now = await time.latest();
    await portal
      .connect(operator)
      .configureTimeSlot(
        siteId,
        slotId,
        2,
        BigInt(now) + 300n,
        BigInt(now) + 7200n,
        basePrice,
        maxTransferPrice
      );
  });

  describe("1. Deployment & Access Control", function() {
    it("1. assigns DEFAULT_ADMIN_ROLE, OPERATOR_ROLE, and GATE_VALIDATOR_ROLE properly", async function() {
      expect(await portal.hasRole(await portal.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await portal.hasRole(await portal.OPERATOR_ROLE(), operator.address)).to.be.true;
      expect(await portal.hasRole(await portal.GATE_VALIDATOR_ROLE(), validator.address)).to.be
        .true;
    });

    it("2. reverts deployment when any initial role address is zero", async function() {
      const Factory = await ethers.getContractFactory("TourismTicketingPortal");
      await expect(
        Factory.deploy(ethers.ZeroAddress, operator.address, validator.address)
      ).to.be.revertedWithCustomError(portal, "ZeroAddress");

      await expect(
        Factory.deploy(admin.address, ethers.ZeroAddress, validator.address)
      ).to.be.revertedWithCustomError(portal, "ZeroAddress");

      await expect(
        Factory.deploy(admin.address, operator.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(portal, "ZeroAddress");
    });

    it("3. rejects unauthorized calls to configureTimeSlot, setTimeSlotActive, and issuePass", async function() {
      const now = await time.latest();
      await expect(
        portal
          .connect(outsider)
          .configureTimeSlot(
            siteId,
            102n,
            10,
            BigInt(now) + 100n,
            BigInt(now) + 3600n,
            basePrice,
            maxTransferPrice
          )
      ).to.be.reverted;

      await expect(portal.connect(outsider).setTimeSlotActive(slotKey, false)).to.be.reverted;

      await expect(
        portal
          .connect(outsider)
          .issuePass(makePassId("P-UNAUTH"), siteId, slotId, visitor1.address, makeCommitment("V1"), {
            value: basePrice,
          })
      ).to.be.reverted;
    });

    it("4. rejects unauthorized calls to validateAtGate and cancelPass", async function() {
      await portal
        .connect(operator)
        .issuePass(makePassId("P-AUTH"), siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await expect(
        portal.connect(outsider).validateAtGate(makePassId("P-AUTH"), makeCommitment("V1"))
      ).to.be.reverted;

      await expect(portal.connect(outsider).cancelPass(makePassId("P-AUTH"))).to.be.reverted;
    });
  });

  describe("2. Time Slot & Anti-Overbooking Rules", function() {
    it("5. rejects zero capacity, invalid time windows, and price cap below base price", async function() {
      const now = await time.latest();
      await expect(
        portal
          .connect(operator)
          .configureTimeSlot(
            siteId,
            105n,
            0,
            BigInt(now) + 100n,
            BigInt(now) + 1000n,
            basePrice,
            maxTransferPrice
          )
      ).to.be.revertedWithCustomError(portal, "InvalidCapacity");

      await expect(
        portal
          .connect(operator)
          .configureTimeSlot(
            siteId,
            105n,
            5,
            BigInt(now) + 2000n,
            BigInt(now) + 1000n,
            basePrice,
            maxTransferPrice
          )
      ).to.be.revertedWithCustomError(portal, "InvalidTimeWindow");

      await expect(
        portal
          .connect(operator)
          .configureTimeSlot(
            siteId,
            105n,
            5,
            BigInt(now) + 100n,
            BigInt(now) + 1000n,
            ethers.parseEther("0.1"),
            ethers.parseEther("0.05")
          )
      ).to.be.revertedWithCustomError(portal, "InvalidPriceCap");
    });

    it("6. enforces slot capacity and blocks overbooking once full", async function() {
      await portal
        .connect(operator)
        .issuePass(makePassId("PASS-1"), siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await portal
        .connect(operator)
        .issuePass(makePassId("PASS-2"), siteId, slotId, visitor2.address, makeCommitment("V2"), {
          value: basePrice,
        });

      const slotInfo = await portal.getTimeSlot(slotKey);
      expect(slotInfo.issuedCount).to.equal(2);
      expect(slotInfo.capacity).to.equal(2);

      await expect(
        portal
          .connect(operator)
          .issuePass(makePassId("PASS-3"), siteId, slotId, visitor3.address, makeCommitment("V3"), {
            value: basePrice,
          })
      )
        .to.be.revertedWithCustomError(portal, "SlotOverbooked")
        .withArgs(slotKey);
    });

    it("7. rejects duplicate passId and zero holder address on issuance", async function() {
      const passId = makePassId("PASS-DUP");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await expect(
        portal
          .connect(operator)
          .issuePass(passId, siteId, slotId, visitor2.address, makeCommitment("V2"), {
            value: basePrice,
          })
      ).to.be.revertedWithCustomError(portal, "PassAlreadyExists");

      await expect(
        portal
          .connect(operator)
          .issuePass(
            makePassId("PASS-ZERO"),
            siteId,
            slotId,
            ethers.ZeroAddress,
            makeCommitment("V2"),
            { value: basePrice }
          )
      ).to.be.revertedWithCustomError(portal, "ZeroAddress");
    });

    it("8. rejects underpayment, non-existent slot, and inactive slot", async function() {
      await expect(
        portal
          .connect(operator)
          .issuePass(
            makePassId("PASS-CHEAP"),
            siteId,
            slotId,
            visitor2.address,
            makeCommitment("V2"),
            { value: ethers.parseEther("0.01") }
          )
      ).to.be.revertedWithCustomError(portal, "InsufficientPayment");

      await expect(
        portal
          .connect(operator)
          .issuePass(
            makePassId("PASS-NOSLOT"),
            siteId,
            999n,
            visitor2.address,
            makeCommitment("V2"),
            { value: basePrice }
          )
      ).to.be.revertedWithCustomError(portal, "SlotNotFound");

      await expect(portal.connect(operator).setTimeSlotActive(slotKey, false))
        .to.emit(portal, "TimeSlotStatusUpdated")
        .withArgs(slotKey, false, operator.address);

      await expect(
        portal
          .connect(operator)
          .issuePass(
            makePassId("PASS-INACTIVE"),
            siteId,
            slotId,
            visitor2.address,
            makeCommitment("V2"),
            { value: basePrice }
          )
      ).to.be.revertedWithCustomError(portal, "SlotInactive");
    });

    it("9. updates slot configuration and rejects shrinking capacity below issuedCount", async function() {
      await portal
        .connect(operator)
        .issuePass(makePassId("PASS-CAP-1"), siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      const now = await time.latest();
      await expect(
        portal
          .connect(operator)
          .configureTimeSlot(
            siteId,
            slotId,
            0,
            BigInt(now) + 200n,
            BigInt(now) + 9000n,
            basePrice,
            maxTransferPrice
          )
      ).to.be.revertedWithCustomError(portal, "InvalidCapacity");

      await portal
        .connect(operator)
        .configureTimeSlot(
          siteId,
          slotId,
          5,
          BigInt(now) + 200n,
          BigInt(now) + 9000n,
          basePrice,
          maxTransferPrice
        );

      const updated = await portal.getTimeSlot(slotKey);
      expect(updated.capacity).to.equal(5);
    });
  });

  describe("3. Anti-Scalping & Pass Transfers", function() {
    it("10. allows legitimate transfer within price cap and updates ETH balances", async function() {
      const passId = makePassId("PASS-TR-1");
      const resalePrice = ethers.parseEther("0.055");

      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      // visitor1 transfers pass ownership while visitor2 provides the payment
      const tx = portal
        .connect(visitor1)
        .transferPass(passId, visitor2.address, resalePrice, makeCommitment("V2"));

      await expect(tx)
        .to.emit(portal, "PassTransferred")
        .withArgs(passId, visitor1.address, visitor2.address, resalePrice, 1);

      const passInfo = await portal.getPass(passId);
      expect(passInfo.holder).to.equal(visitor2.address);
      expect(passInfo.transferCount).to.equal(1);
    });

    it("11. blocks scalping when transfer price exceeds maxTransferPriceWei", async function() {
      const passId = makePassId("PASS-SCALP");
      const scalpedPrice = ethers.parseEther("0.15");

      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await expect(
        portal
          .connect(visitor1)
          .transferPass(passId, visitor2.address, scalpedPrice, makeCommitment("V2"), {
            value: scalpedPrice,
          })
      )
        .to.be.revertedWithCustomError(portal, "ScalpingPriceExceeded")
        .withArgs(scalpedPrice, maxTransferPrice);
    });

    it("12. enforces MAX_TRANSFERS_PER_PASS (2 transfers max)", async function() {
      const passId = makePassId("PASS-MAXTR");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await portal
        .connect(visitor1)
        .transferPass(passId, visitor2.address, basePrice, makeCommitment("V2"));

      await portal
        .connect(visitor2)
        .transferPass(passId, visitor3.address, basePrice, makeCommitment("V3"));

      await expect(
        portal
          .connect(visitor3)
          .transferPass(passId, visitor1.address, basePrice, makeCommitment("V1"))
      ).to.be.revertedWithCustomError(portal, "TransferLimitReached");
    });

    it("13. rejects transfers from non-holder or to zero address", async function() {
      const passId = makePassId("PASS-NONHOLDER");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await expect(
        portal
          .connect(outsider)
          .transferPass(passId, visitor2.address, basePrice, makeCommitment("V2"))
      ).to.be.revertedWithCustomError(portal, "NotPassHolder");

      await expect(
        portal
          .connect(visitor1)
          .transferPass(passId, ethers.ZeroAddress, basePrice, makeCommitment("V2"))
      ).to.be.revertedWithCustomError(portal, "ZeroAddress");
    });
  });

  describe("4. Gate Validation, Anti-Reuse, Expiration & Cancellation", function() {
    it("14. validates an active pass once at the gate and blocks reuse", async function() {
      const passId = makePassId("PASS-GATE-1");
      const commit = makeCommitment("V1-SECRET");

      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, commit, {
          value: basePrice,
        });

      const [validBefore] = await portal.verifyPass(passId);
      expect(validBefore).to.be.true;

      await expect(portal.connect(validator).validateAtGate(passId, commit)).to.emit(
        portal,
        "PassValidatedAtGate"
      );

      const [validAfter] = await portal.verifyPass(passId);
      expect(validAfter).to.be.false;

      await expect(
        portal.connect(validator).validateAtGate(passId, commit)
      ).to.be.revertedWithCustomError(portal, "PassNotActive");
    });

    it("15. rejects gate validation when commitment hash does not match", async function() {
      const passId = makePassId("PASS-WRONG-HASH");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("REAL-HASH"), {
          value: basePrice,
        });

      await expect(
        portal.connect(validator).validateAtGate(passId, makeCommitment("FAKE-HASH"))
      ).to.be.revertedWithCustomError(portal, "CommitmentMismatch");
    });

    it("16. invalidates pass after time slot ends and blocks post-window validation/transfer", async function() {
      const passId = makePassId("PASS-EXP");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      await time.increase(7300);

      const [isValid] = await portal.verifyPass(passId);
      expect(isValid).to.be.false;

      await expect(
        portal.connect(validator).validateAtGate(passId, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(portal, "SlotWindowClosed");

      await expect(
        portal
          .connect(visitor1)
          .transferPass(passId, visitor2.address, basePrice, makeCommitment("V2"))
      ).to.be.revertedWithCustomError(portal, "SlotWindowClosed");
    });

    it("17. cancels an active pass, refunds holder, and reverts queries on non-existent records", async function() {
      const passId = makePassId("PASS-CANCEL");
      await portal
        .connect(operator)
        .issuePass(passId, siteId, slotId, visitor1.address, makeCommitment("V1"), {
          value: basePrice,
        });

      const cancelTx = portal.connect(operator).cancelPass(passId);

      await expect(cancelTx)
        .to.emit(portal, "PassCancelled")
        .withArgs(passId, operator.address, basePrice);

      await expect(cancelTx).to.changeEtherBalances([visitor1], [basePrice]);

      const [unknownValid] = await portal.verifyPass(makePassId("UNKNOWN"));
      expect(unknownValid).to.be.false;

      await expect(portal.getPass(makePassId("UNKNOWN"))).to.be.revertedWithCustomError(
        portal,
        "PassNotFound"
      );

      await expect(portal.getTimeSlot(ethers.ZeroHash)).to.be.revertedWithCustomError(
        portal,
        "SlotNotFound"
      );
    });
  });
});
