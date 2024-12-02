import { ethers } from "ethers";
import * as dotenv from "dotenv";
const fs = require("fs");
const path = require("path");
dotenv.config();

// Setup env variables
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

let chainId = 31337;

const avsDeploymentData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `../contracts/deployments/depeg/${chainId}.json`),
    "utf8"
  )
);
const depegServiceManagerAddress =
  avsDeploymentData.addresses.depegServiceManager;
const depegServiceManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/DepegServiceManager.json"),
    "utf8"
  )
);
// Initialize contract objects from ABIs
const depegServiceManager = new ethers.Contract(
  depegServiceManagerAddress,
  depegServiceManagerABI,
  wallet
);

/**@notice Returns two random timestamps within last year and have 3-72 hours between them */
function getRandomTimestamps() {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const oneYearAgo = currentTimestamp - 31536000;

  // Randomly pick a start timestamp within the last year
  const startTimestamp = Math.floor(
    Math.random() * (currentTimestamp - oneYearAgo) + oneYearAgo
  );

  // Define the range for the gap between the timestamps (3 to 72 hours in seconds for demo)
  const minGap = 3 * 60 * 60; // 3 hours in seconds
  const maxGap = 72 * 60 * 60; // 72 hours in seconds

  // Randomly generate a gap within the allowed range
  const gap = Math.floor(Math.random() * (maxGap - minGap) + minGap);

  // Calculate the end timestamp
  const endTimestamp = startTimestamp + gap;

  // Ensure the end timestamp does not exceed the current timestamp
  if (endTimestamp > currentTimestamp) {
    return getRandomTimestamps(); // Re-run the function if out of range
  }

  return [startTimestamp, endTimestamp];
}

/**@notice Function to generate task creation data
 * @dev Uses the same data as `test/DepegServiceManager.t.sol`'s `testCreateTask()`
 */
function generateTaskData(): {
  token: string;
  startTime: number;
  endTime: number;
  sources: string[];
} {
  const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  // const startTime = 1732240000;
  // const endTime = 1732250000;
  const [startTime, endTime] = getRandomTimestamps();
  const sources = ["https://coinmarketcap.com/currencies/usd-coin/"];
  return { token, startTime, endTime, sources };
}

/**@notice Calls the DepegServiceManager's `createNewTask()` function */
async function createNewTask(
  token: string,
  startTime: number,
  endTime: number
  // sources: string[]
) {
  try {
    const tx = await depegServiceManager.createNewTask(
      token,
      startTime,
      endTime
      // sources
    );

    // Wait for the transaction to be mined
    const receipt = await tx.wait();

    console.log(`Transaction successful with hash: ${receipt.hash}`);
  } catch (error) {
    console.error("Error sending transaction:", error);
  }
}

// Function to create a new task every 15 seconds
function startCreatingTasks() {
  setInterval(() => {
    const { token, startTime, endTime, sources } = generateTaskData();
    console.log(`Creating new task for token: ${token}`);
    console.log(`Start: ${startTime}`);
    console.log(`End: ${endTime}`);
    // console.log(`Sources: ${sources}`);
    createNewTask(token, startTime, endTime);
  }, 24000);
}

// Start the process
startCreatingTasks();
