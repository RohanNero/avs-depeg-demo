import { ethers } from "ethers";
import * as dotenv from "dotenv";
const fs = require("fs");
const path = require("path");
dotenv.config();

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

// Function to generate random names
// function generateRandomName(): string {
//   const adjectives = ["Quick", "Lazy", "Sleepy", "Noisy", "Hungry"];
//   const nouns = ["Fox", "Dog", "Cat", "Mouse", "Bear"];
//   const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
//   const noun = nouns[Math.floor(Math.random() * nouns.length)];
//   const randomName = `${adjective}${noun}${Math.floor(Math.random() * 1000)}`;
//   return randomName;
// }

/**@notice Function to generate task creation data
 * @dev Uses the same data as `test/DepegServiceManager.t.sol`'s `testCreateTask()`
 */
function generateTaskData(): {
  token: string;
  startTime: number;
  endTime: number;
  sources: string[];
} {
  const token = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const startTime = 1732252000;
  const endTime = 1732253000;
  const sources = ["https://coinmarketcap.com/currencies/usd-coin/"];
  return { token, startTime, endTime, sources };
}

/**@notice Calls the DepegServiceManager's `createNewTask()` function */
async function createNewTask(
  token: string,
  startTime: number,
  endTime: number,
  sources: string[]
) {
  try {
    const tx = await depegServiceManager.createNewTask(
      token,
      startTime,
      endTime,
      sources
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
    console.log(`Sources: ${sources}`);
    createNewTask(token, startTime, endTime, sources);
  }, 24000);
}

// Start the process
startCreatingTasks();
