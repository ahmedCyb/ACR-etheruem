const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying TourismTicketingPortal with account:", deployer.address);

  const adminAddr = process.env.ADMIN_ADDRESS || deployer.address;
  const operatorAddr = process.env.OPERATOR_ADDRESS || deployer.address;
  const validatorAddr = process.env.VALIDATOR_ADDRESS || deployer.address;

  const Portal = await hre.ethers.getContractFactory("TourismTicketingPortal");
  const portal = await Portal.deploy(adminAddr, operatorAddr, validatorAddr);
  await portal.waitForDeployment();

  const contractAddress = await portal.getAddress();
  const deployTx = portal.deploymentTransaction();
  console.log("TourismTicketingPortal deployed to:", contractAddress);
  if (deployTx) {
    console.log("Deployment tx hash:", deployTx.hash);
  }

  const latestBlock = await hre.ethers.provider.getBlock("latest");
  const now = BigInt(latestBlock.timestamp);
  const siteId = hre.ethers.encodeBytes32String("MADINAH_HERITAGE");
  const slotId = 1n;
  const basePriceWei = hre.ethers.parseEther("0.0001");
  const maxTransferPriceWei = hre.ethers.parseEther("0.00012");

  console.log("Executing 3 live write transactions on Sepolia...");

  // Tx 1: Configure time slot
  const tx1 = await portal.configureTimeSlot(
    siteId,
    slotId,
    50,
    now + 60n,
    now + 86400n,
    basePriceWei,
    maxTransferPriceWei
  );
  const receipt1 = await tx1.wait();
  console.log("Tx 1 (configureTimeSlot):", receipt1.hash);

  // Tx 2: Issue admission pass
  const passId = hre.ethers.id("MADINAH-PASS-001");
  const commitmentHash = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("VISITOR-COMMITMENT-001")
  );
  const tx2 = await portal.issuePass(passId, siteId, slotId, deployer.address, commitmentHash, {
    value: basePriceWei,
  });
  const receipt2 = await tx2.wait();
  console.log("Tx 2 (issuePass):", receipt2.hash);

  // Tx 3: Validate pass at gate (single entry)
  const tx3 = await portal.validateAtGate(passId, commitmentHash);
  const receipt3 = await tx3.wait();
  console.log("Tx 3 (validateAtGate):", receipt3.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
