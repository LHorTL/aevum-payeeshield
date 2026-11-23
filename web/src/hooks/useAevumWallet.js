import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import { AEVUM_NETWORK, ERC20_ABI } from "../config/aevum.js";

export function useAevumWallet() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [tQdayBalance, setTQdayBalance] = useState(null);
  const [tUsd8Balance, setTUsd8Balance] = useState(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  const hasProvider = typeof window !== "undefined" && Boolean(window.ethereum);
  const isOnAevum = chainId === AEVUM_NETWORK.chainIdDecimal;

  const refreshBalances = useCallback(async (addr) => {
    if (!addr || !window.ethereum) return;
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const net = await provider.getNetwork();
      const cid = Number(net.chainId);
      setChainId(cid);
      const nativeBal = await provider.getBalance(addr);
      setTQdayBalance(ethers.formatEther(nativeBal));

      if (cid === AEVUM_NETWORK.chainIdDecimal) {
        const token = new ethers.Contract(AEVUM_NETWORK.contracts.tUSD8, ERC20_ABI, provider);
        const bal = await token.balanceOf(addr);
        setTUsd8Balance(bal);
      } else {
        setTUsd8Balance(null);
      }
    } catch (e) {
      setError(e?.shortMessage || e?.message || "Failed reading Aevum balances");
    }
  }, []);

  const switchToAevum = useCallback(async () => {
    if (!window.ethereum) {
      setError("No EIP-1193 wallet (MetaMask / Rabby) detected. Use Interactive Simulation Mode to test immediately.");
      return false;
    }
    setError("");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: AEVUM_NETWORK.chainIdHex }]
      });
      return true;
    } catch (switchErr) {
      if (switchErr?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: AEVUM_NETWORK.chainIdHex,
                chainName: AEVUM_NETWORK.chainName,
                rpcUrls: [AEVUM_NETWORK.rpcUrl],
                blockExplorerUrls: [AEVUM_NETWORK.explorerUrl],
                nativeCurrency: AEVUM_NETWORK.nativeCurrency
              }
            ]
          });
          return true;
        } catch (addErr) {
          setError(addErr?.message || "User rejected adding QDay Aevum Testnet (44005).");
          return false;
        }
      }
      setError(switchErr?.message || "Could not switch to QDay Aevum Testnet (44005).");
      return false;
    }
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No EIP-1193 browser wallet found. Switch to Interactive Simulation Mode for zero-setup judging.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts[0]) {
        setAccount(accounts[0]);
        await switchToAevum();
        await refreshBalances(accounts[0]);
      }
    } catch (e) {
      setError(e?.message || "Wallet connection cancelled.");
    } finally {
      setConnecting(false);
    }
  }, [refreshBalances, switchToAevum]);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccountsChanged = (accs) => {
      const next = accs && accs[0] ? accs[0] : "";
      setAccount(next);
      if (next) refreshBalances(next);
    };
    const onChainChanged = () => {
      if (account) refreshBalances(account);
    };
    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum.removeListener?.("chainChanged", onChainChanged);
    };
  }, [account, refreshBalances]);

  return {
    account,
    chainId,
    isOnAevum,
    hasProvider,
    tQdayBalance,
    tUsd8Balance,
    connecting,
    error,
    connect,
    switchToAevum,
    refreshBalances
  };
}
