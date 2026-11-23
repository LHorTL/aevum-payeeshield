require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const AEVUM_RPC_URL = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const isValidKey = /^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_PRIVATE_KEY);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true,
      evmVersion: "shanghai"
    }
  },
  networks: {
    hardhat: {
      chainId: 44005
    },
    aevumTestnet: {
      url: AEVUM_RPC_URL,
      chainId: 44005,
      accounts: isValidKey ? [DEPLOYER_PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: {
      aevumTestnet: "no-api-key-needed"
    },
    customChains: [
      {
        network: "aevumTestnet",
        chainId: 44005,
        urls: {
          apiURL: "https://explorer-test.qday.info/api",
          browserURL: "https://explorer-test.qday.info"
        }
      }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
