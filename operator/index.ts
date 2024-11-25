import { ethers } from "ethers";
import * as dotenv from "dotenv";
const fs = require("fs");
const path = require("path");
dotenv.config();

// Check if the process.env object is empty
if (!Object.keys(process.env).length) {
  throw new Error("process.env object is empty");
}

// Setup env variables
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
/// TODO: Hack
let chainId = 31337;

const avsDeploymentData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `../contracts/deployments/depeg/${chainId}.json`),
    "utf8"
  )
);
// Load core deployment data
const coreDeploymentData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `../contracts/deployments/core/${chainId}.json`),
    "utf8"
  )
);

const delegationManagerAddress = coreDeploymentData.addresses.delegation; // todo: reminder to fix the naming of this contract in the deployment file, change to delegationManager
const avsDirectoryAddress = coreDeploymentData.addresses.avsDirectory;
const depegServiceManagerAddress =
  avsDeploymentData.addresses.depegServiceManager;
const ecdsaStakeRegistryAddress = avsDeploymentData.addresses.stakeRegistry;

// Load ABIs
const delegationManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/IDelegationManager.json"),
    "utf8"
  )
);
const ecdsaRegistryABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/ECDSAStakeRegistry.json"),
    "utf8"
  )
);
const depegServiceManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/DepegServiceManager.json"),
    "utf8"
  )
);
const avsDirectoryABI = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../abis/IAVSDirectory.json"), "utf8")
);

// Initialize contract objects from ABIs
const delegationManager = new ethers.Contract(
  delegationManagerAddress,
  delegationManagerABI,
  wallet
);
const depegServiceManager = new ethers.Contract(
  depegServiceManagerAddress,
  depegServiceManagerABI,
  wallet
);
const ecdsaRegistryContract = new ethers.Contract(
  ecdsaStakeRegistryAddress,
  ecdsaRegistryABI,
  wallet
);
const avsDirectory = new ethers.Contract(
  avsDirectoryAddress,
  avsDirectoryABI,
  wallet
);

// This function needs to use inputted timestamp(s) to view historical price
// If we can confirm the stablecoin price at the timestamp(s) was below the set threshold, then we respond.
const signAndRespondToTask = async (
  taskIndex: number,
  taskCreatedBlock: number,
  taskToken: string,
  taskStart: number,
  taskEnd: number,
  taskSources: string[]
) => {
  // Create same message hash as `DepegServiceManager`'s `respondToTask()`
  const messageHash = ethers.solidityPackedKeccak256(
    ["string", "uint40", "uint40"],
    [taskToken, taskStart, taskEnd]
  );
  const messageBytes = ethers.getBytes(messageHash);
  const signature = await wallet.signMessage(messageBytes);
  console.log("MessageBytes:", messageBytes);

  console.log(`Signing data for task ${taskIndex}...`);

  const operators = [await wallet.getAddress()];
  const signatures = [signature];

  console.log("Input sources:", taskSources);
  console.log("Input token:", taskToken);
  console.log("Input start:", taskStart);

  const signedTask = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address[]", "bytes[]", "uint32"],
    [
      operators,
      signatures,
      ethers.toBigInt((await provider.getBlockNumber()) - 1),
    ]
  );
  console.log("Message Hash:", messageHash);
  console.log("Signatures:", signatures);
  console.log("Signed Task:", signedTask);

  // Call `respondToTask()` function
  console.log(`Responding to task ${taskIndex}...`);
  const tx = await depegServiceManager.respondToTask(
    {
      token: taskToken,
      startTimestamp: taskStart,
      endTimestamp: taskEnd,
      sources: ["https://coinmarketcap.com/currencies/usd-coin/"],
      taskCreatedBlock: taskCreatedBlock,
    },
    taskIndex,
    signedTask
  );
  await tx.wait();
  console.log(`Responded to task.`);
};

// Registers as an Operator in EigenLayer.
const registerOperator = async () => {
  try {
    const tx1 = await delegationManager.registerAsOperator(
      {
        __deprecated_earningsReceiver: await wallet.address,
        delegationApprover: "0x0000000000000000000000000000000000000000",
        stakerOptOutWindowBlocks: 0,
      },
      ""
    );
    await tx1.wait();
    console.log("Operator registered to Core EigenLayer contracts");
  } catch (error) {
    console.error("Error in registering as operator:", error);
  }

  const salt = ethers.hexlify(ethers.randomBytes(32));
  const expiry = Math.floor(Date.now() / 1000) + 3600; // Example expiry, 1 hour from now

  // Define the output structure
  let operatorSignatureWithSaltAndExpiry = {
    signature: "",
    salt: salt,
    expiry: expiry,
  };

  // Calculate the digest hash, which is a unique value representing the operator, avs, unique value (salt) and expiration date.
  const operatorDigestHash =
    await avsDirectory.calculateOperatorAVSRegistrationDigestHash(
      wallet.address,
      await depegServiceManager.getAddress(),
      salt,
      expiry
    );
  console.log(operatorDigestHash);

  // Sign the digest hash with the operator's private key
  console.log("Signing digest hash with operator's private key");
  const operatorSigningKey = new ethers.SigningKey(process.env.PRIVATE_KEY!);
  const operatorSignedDigestHash = operatorSigningKey.sign(operatorDigestHash);

  // Encode the signature in the required format
  operatorSignatureWithSaltAndExpiry.signature = ethers.Signature.from(
    operatorSignedDigestHash
  ).serialized;

  console.log("Registering Operator to AVS Registry contract");

  // Register Operator to AVS
  // Per release here: https://github.com/Layr-Labs/eigenlayer-middleware/blob/v0.2.1-mainnet-rewards/src/unaudited/ECDSAStakeRegistry.sol#L49
  const tx2 = await ecdsaRegistryContract.registerOperatorWithSignature(
    operatorSignatureWithSaltAndExpiry,
    wallet.address
  );
  await tx2.wait();
  console.log("Operator registered on AVS successfully");
};

// Listens and waits for new tasks to be created
const monitorNewTasks = async () => {
  //console.log(`Creating new task "EigenWorld"`);
  //await depegServiceManager.createNewTask("EigenWorld");

  depegServiceManager.on(
    "NewTaskCreated",
    async (taskIndex: number, task: any) => {
      //   console.log("New Task:", task);
      console.log(`New task detected with token: ${task.token}`);
      console.log(`Start: ${task.startTimestamp}`);
      console.log(`End: ${task.endTimestamp}`);
      console.log(`Sources: ${task.sources}`);
      await signAndRespondToTask(
        taskIndex,
        task.taskCreatedBlock,
        task.token,
        task.startTimestamp,
        task.endTimestamp,
        task.sources
      );
    }
  );

  console.log("Monitoring for new tasks...");
};

// Register Eigenlayer Operator to `delegationManager` then monitor for new tasks
const main = async () => {
  await registerOperator();
  monitorNewTasks().catch((error) => {
    console.error("Error monitoring tasks:", error);
  });
};

main().catch((error) => {
  console.error("Error in main function:", error);
});
