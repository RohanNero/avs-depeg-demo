import { ethers } from "ethers";
import * as dotenv from "dotenv";
import axios from "axios";
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
    ["address", "uint40", "uint40"],
    [taskToken, taskStart, taskEnd]
  );
  const messageBytes = ethers.getBytes(messageHash);
  const signature = await wallet.signMessage(messageBytes);

  console.log(`Signing data for task ${taskIndex}...`);

  const operators = [await wallet.getAddress()];
  const signatures = [signature];

  const signedTask = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address[]", "bytes[]", "uint32"],
    [
      operators,
      signatures,
      ethers.toBigInt((await provider.getBlockNumber()) - 1),
    ]
  );
  console.log(`Task ${taskIndex} signed successfully.`);

  // Call `respondToTask()` function
  console.log(`Responding to task ${taskIndex}...`);
  const tx = await depegServiceManager.respondToTask(
    {
      token: taskToken,
      startTimestamp: taskStart,
      endTimestamp: taskEnd,
      //   sources: ["https://coinmarketcap.com/currencies/usd-coin/"],
      taskCreatedBlock: taskCreatedBlock,
    },
    taskIndex,
    signedTask
  );
  await tx.wait();
  console.log(`Responded to task successfully.`);
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

// Uses task data to check stablecoin price at certain timestamps
const validateTaskData = async (
  taskToken: string,
  taskStart: number,
  taskEnd: number
) => {
  // Currently doesn't use `taskToken` contract address but easily could map it to the string `usd_coin` in the URL

  // Validate that the timestamps were:
  //    - start < end
  //    - within the last year
  //    - at least 10,000 seconds apart
  const oneYearAgo = Math.floor(Date.now() / 1000) - 31536000;
  const MINIMUM_RANGE = 10000;
  // If avg price is $0.9999 or less, task is valid (raise/lower this value to test a depeg response)
  const PRICE_THRESHOLD = 0.9999 as number;

  // Validate that the start timestamp is less than the end timestamp
  if (taskStart >= taskEnd) {
    throw new Error(
      "Ending timestamp must be greater than starting timestamp."
    );
  }
  // Validate that the timestamps were within the last year (CoinGecko demo API key limit)
  if (taskStart < oneYearAgo || taskEnd < oneYearAgo) {
    throw new Error("Timestamps must be within the last year.");
  }

  // Validate that the timestamps are at least 10,000 seconds apart (minimum 3 different prices returned)
  if (taskEnd - taskStart < MINIMUM_RANGE) {
    throw new Error("Timestamps must be at least 10,000 seconds apart.");
  }

  if (taskStart)
    try {
      // CoinGecko API endpoint for historical price data
      console.log("Fetching price data from Coin Gecko...");
      const options = {
        method: "GET",
        url: "https://api.coingecko.com/api/v3/coins/usd-coin/market_chart/range",
        params: {
          vs_currency: "usd",
          from: taskStart,
          to: taskEnd,
          precision: "8",
        },
        headers: {
          accept: "application/json",
          "x-cg-demo-api-key": process.env.COINGECKO_API_KEY,
        },
      };

      const response = await axios
        .request(options)
        .catch((err) => console.error(err));

      // Assuming you want to check if the price is below the threshold
      if (response) {
        console.log("Price data fetched!");
        // Array of `[timestamp, price]` objects with 8 decimals
        const prices = response.data.prices.map((pair: number[]) => pair[1]);
        const averagePrice =
          prices.reduce((sum: number, price: number) => sum + price, 0) /
          prices.length;

        // console.log("prices:", prices);
        console.log("Average price at time frame: ", averagePrice);

        if (PRICE_THRESHOLD >= averagePrice) {
          console.log("Price below or at minimum threshold.");
          return true;
        } else {
          console.log("Price above minimum threshold.");
          return false;
        }
      }
    } catch (error) {
      console.error("Error fetching token price:", error);
      return false;
    }
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
      //   console.log(`Sources: ${task.sources}`);
      // Now that we have the created task's data, lets use a function to validate the price
      const validTask = await validateTaskData(
        task.token,
        task.startTimestamp,
        task.endTimestamp
      );
      // Conditionally respond if the task if valid
      if (validTask) {
        await signAndRespondToTask(
          taskIndex,
          task.taskCreatedBlock,
          task.token,
          task.startTimestamp,
          task.endTimestamp,
          task.sources
        );
      } else {
        console.log("Task invalid, not responding.");
      }
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
