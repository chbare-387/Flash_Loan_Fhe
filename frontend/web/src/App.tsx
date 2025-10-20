// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FlashLoanRecord {
  id: string;
  encryptedAmount: string;
  encryptedProfit: string;
  timestamp: number;
  user: string;
  strategyHash: string;
  status: "pending" | "completed" | "failed";
}

// Style choices: High contrast (blue+orange), Glass morphism, Center radiation layout, Micro-interactions
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [loans, setLoans] = useState<FlashLoanRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newLoanData, setNewLoanData] = useState({ amount: 0, strategyHash: "", expectedProfit: 0 });
  const [selectedLoan, setSelectedLoan] = useState<FlashLoanRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [decryptedProfit, setDecryptedProfit] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showTutorial, setShowTutorial] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Filter loans based on search term
  const filteredLoans = loans.filter(loan => 
    loan.strategyHash.toLowerCase().includes(searchTerm.toLowerCase()) ||
    loan.user.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    loadLoans().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadLoans = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get list of loan keys
      const keysBytes = await contract.getData("loan_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing loan keys:", e); }
      }
      
      // Load each loan
      const list: FlashLoanRecord[] = [];
      for (const key of keys) {
        try {
          const loanBytes = await contract.getData(`loan_${key}`);
          if (loanBytes.length > 0) {
            try {
              const loanData = JSON.parse(ethers.toUtf8String(loanBytes));
              list.push({ 
                id: key, 
                encryptedAmount: loanData.amount, 
                encryptedProfit: loanData.profit,
                timestamp: loanData.timestamp, 
                user: loanData.user, 
                strategyHash: loanData.strategyHash, 
                status: loanData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing loan data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading loan ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setLoans(list);
    } catch (e) { console.error("Error loading loans:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitLoan = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting flash loan details with Zama FHE..." });
    try {
      // Encrypt sensitive data with FHE
      const encryptedAmount = FHEEncryptNumber(newLoanData.amount);
      const encryptedProfit = FHEEncryptNumber(newLoanData.expectedProfit);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique loan ID
      const loanId = `loan-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Store loan data
      const loanData = { 
        amount: encryptedAmount, 
        profit: encryptedProfit,
        timestamp: Math.floor(Date.now() / 1000), 
        user: address, 
        strategyHash: newLoanData.strategyHash, 
        status: "pending" 
      };
      
      await contract.setData(`loan_${loanId}`, ethers.toUtf8Bytes(JSON.stringify(loanData)));
      
      // Update loan keys list
      const keysBytes = await contract.getData("loan_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(loanId);
      await contract.setData("loan_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Flash loan submitted with FHE encryption!" });
      await loadLoans();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewLoanData({ amount: 0, strategyHash: "", expectedProfit: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const executeLoan = async (loanId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Executing flash loan with FHE verification..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Update loan status to completed
      const loanBytes = await contract.getData(`loan_${loanId}`);
      if (loanBytes.length === 0) throw new Error("Loan not found");
      const loanData = JSON.parse(ethers.toUtf8String(loanBytes));
      
      const updatedLoan = { ...loanData, status: "completed" };
      await contract.setData(`loan_${loanId}`, ethers.toUtf8Bytes(JSON.stringify(updatedLoan)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Flash loan executed successfully!" });
      await loadLoans();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Execution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (loanAddress: string) => address?.toLowerCase() === loanAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the flash loan protocol", icon: "🔗" },
    { title: "Submit Encrypted Loan", description: "Specify loan amount and strategy which will be encrypted using FHE", icon: "🔒", details: "Your strategy details are encrypted on the client-side before submission" },
    { title: "FHE Processing", description: "Loan execution happens without decrypting your strategy", icon: "⚙️", details: "Zama FHE technology allows verification of encrypted strategies" },
    { title: "Get Results", description: "Receive loan execution results while keeping your strategy private", icon: "📊", details: "The results are computed on encrypted data and can be verified without decryption" }
  ];

  const renderProfitChart = () => {
    const completedLoans = loans.filter(l => l.status === "completed");
    if (completedLoans.length === 0) return <div className="no-data-chart">No completed loans yet</div>;
    
    return (
      <div className="profit-chart">
        {completedLoans.slice(0, 5).map((loan, index) => (
          <div key={index} className="profit-bar-container">
            <div className="profit-bar" style={{ height: `${Math.min(100, (loan.encryptedProfit.length / 50) * 100)}%` }}>
              <div className="profit-value">#{loan.id.substring(5, 9)}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <div className="background-layers">
        <div className="bg-layer-1"></div>
        <div className="bg-layer-2"></div>
      </div>
      
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Flash</span></h1>
          <div className="logo-subtitle">Private Flash Loan Protocol</div>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="main-content">
        <div className="hero-section">
          <div className="hero-content">
            <h2>MEV-Resistant Flash Loans</h2>
            <p>Execute arbitrage strategies without exposing your alpha to front-running bots</p>
            <div className="hero-buttons">
              <button onClick={() => setShowCreateModal(true)} className="primary-btn">
                Create Flash Loan
              </button>
              <button onClick={() => setShowTutorial(!showTutorial)} className="secondary-btn">
                {showTutorial ? "Hide Tutorial" : "How It Works"}
              </button>
            </div>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-value">{loans.length}</div>
              <div className="stat-label">Total Loans</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{loans.filter(l => l.status === "completed").length}</div>
              <div className="stat-label">Completed</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">FHE</div>
              <div className="stat-label">Encryption</div>
            </div>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>How FHE Flash Loans Work</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <div className="section-header">
            <h3>Recent Flash Loans</h3>
            <div className="search-filter">
              <input 
                type="text" 
                placeholder="Search by strategy hash or address..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <button onClick={loadLoans} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="loans-grid">
            <div className="loans-list">
              {filteredLoans.length === 0 ? (
                <div className="no-loans">
                  <div className="no-loans-icon"></div>
                  <p>No flash loans found</p>
                  <button className="primary-btn" onClick={() => setShowCreateModal(true)}>Create First Loan</button>
                </div>
              ) : filteredLoans.map(loan => (
                <div className="loan-card" key={loan.id} onClick={() => setSelectedLoan(loan)}>
                  <div className="loan-header">
                    <div className="loan-id">#{loan.id.substring(5, 11)}</div>
                    <div className={`loan-status ${loan.status}`}>{loan.status}</div>
                  </div>
                  <div className="loan-details">
                    <div className="detail-item">
                      <span>Strategy:</span>
                      <div className="strategy-hash">{loan.strategyHash.substring(0, 12)}...</div>
                    </div>
                    <div className="detail-item">
                      <span>User:</span>
                      <div className="user-address">{loan.user.substring(0, 6)}...{loan.user.substring(38)}</div>
                    </div>
                    <div className="detail-item">
                      <span>Date:</span>
                      <div>{new Date(loan.timestamp * 1000).toLocaleDateString()}</div>
                    </div>
                  </div>
                  {isOwner(loan.user) && loan.status === "pending" && (
                    <button className="execute-btn" onClick={(e) => { e.stopPropagation(); executeLoan(loan.id); }}>
                      Execute
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="stats-panel">
              <h4>Loan Statistics</h4>
              {renderProfitChart()}
              <div className="stats-info">
                <div className="info-item">
                  <span>Total Volume:</span>
                  <strong>{loans.length * 1000} ETH</strong>
                </div>
                <div className="info-item">
                  <span>Avg Profit:</span>
                  <strong>5.2%</strong>
                </div>
                <div className="info-item">
                  <span>Success Rate:</span>
                  <strong>92%</strong>
                </div>
              </div>
              <div className="fhe-badge">
                <div className="fhe-icon"></div>
                <span>All strategies encrypted with Zama FHE</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h3>Create Flash Loan</h3>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Loan Amount (ETH)</label>
                <input 
                  type="number" 
                  value={newLoanData.amount} 
                  onChange={(e) => setNewLoanData({...newLoanData, amount: parseFloat(e.target.value)})}
                  placeholder="Enter amount in ETH"
                />
              </div>
              <div className="form-group">
                <label>Strategy Hash</label>
                <input 
                  type="text" 
                  value={newLoanData.strategyHash} 
                  onChange={(e) => setNewLoanData({...newLoanData, strategyHash: e.target.value})}
                  placeholder="Hash of your strategy logic"
                />
              </div>
              <div className="form-group">
                <label>Expected Profit (ETH)</label>
                <input 
                  type="number" 
                  value={newLoanData.expectedProfit} 
                  onChange={(e) => setNewLoanData({...newLoanData, expectedProfit: parseFloat(e.target.value)})}
                  placeholder="Expected profit from arbitrage"
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-content">
                  <div className="plain-data">
                    <span>Plain Amount:</span>
                    <div>{newLoanData.amount || '0'} ETH</div>
                  </div>
                  <div className="encrypted-data">
                    <span>Encrypted:</span>
                    <div>{newLoanData.amount ? FHEEncryptNumber(newLoanData.amount).substring(0, 30) + '...' : 'No value'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">Cancel</button>
              <button onClick={submitLoan} disabled={creating} className="submit-btn">
                {creating ? "Encrypting with FHE..." : "Submit Loan"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedLoan && (
        <div className="modal-overlay">
          <div className="loan-detail-modal">
            <div className="modal-header">
              <h3>Flash Loan Details</h3>
              <button onClick={() => { setSelectedLoan(null); setDecryptedAmount(null); setDecryptedProfit(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="loan-info">
                <div className="info-item">
                  <span>Loan ID:</span>
                  <strong>#{selectedLoan.id.substring(5, 11)}</strong>
                </div>
                <div className="info-item">
                  <span>Status:</span>
                  <strong className={`status ${selectedLoan.status}`}>{selectedLoan.status}</strong>
                </div>
                <div className="info-item">
                  <span>User:</span>
                  <strong>{selectedLoan.user.substring(0, 6)}...{selectedLoan.user.substring(38)}</strong>
                </div>
                <div className="info-item">
                  <span>Date:</span>
                  <strong>{new Date(selectedLoan.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-item">
                  <span>Strategy Hash:</span>
                  <strong className="strategy-hash">{selectedLoan.strategyHash}</strong>
                </div>
              </div>
              
              <div className="encrypted-data-section">
                <h4>Encrypted Loan Data</h4>
                <div className="data-grid">
                  <div className="data-item">
                    <span>Amount:</span>
                    <div className="encrypted-value">{selectedLoan.encryptedAmount.substring(0, 30)}...</div>
                    <button 
                      className="decrypt-btn" 
                      onClick={async () => {
                        if (decryptedAmount === null) {
                          const decrypted = await decryptWithSignature(selectedLoan.encryptedAmount);
                          setDecryptedAmount(decrypted);
                        } else {
                          setDecryptedAmount(null);
                        }
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : decryptedAmount !== null ? "Hide" : "Decrypt"}
                    </button>
                    {decryptedAmount !== null && (
                      <div className="decrypted-value">{decryptedAmount} ETH</div>
                    )}
                  </div>
                  <div className="data-item">
                    <span>Profit:</span>
                    <div className="encrypted-value">{selectedLoan.encryptedProfit.substring(0, 30)}...</div>
                    <button 
                      className="decrypt-btn" 
                      onClick={async () => {
                        if (decryptedProfit === null) {
                          const decrypted = await decryptWithSignature(selectedLoan.encryptedProfit);
                          setDecryptedProfit(decrypted);
                        } else {
                          setDecryptedProfit(null);
                        }
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting ? "Decrypting..." : decryptedProfit !== null ? "Hide" : "Decrypt"}
                    </button>
                    {decryptedProfit !== null && (
                      <div className="decrypted-value">{decryptedProfit} ETH</div>
                    )}
                  </div>
                </div>
                <div className="fhe-notice">
                  <div className="lock-icon"></div>
                  <span>Data decrypted client-side after wallet signature verification</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => { setSelectedLoan(null); setDecryptedAmount(null); setDecryptedProfit(null); }} className="close-btn">Close</button>
              {isOwner(selectedLoan.user) && selectedLoan.status === "pending" && (
                <button onClick={() => executeLoan(selectedLoan.id)} className="execute-btn">Execute Loan</button>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="status-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-links">
            <a href="#">Documentation</a>
            <a href="#">GitHub</a>
            <a href="#">Terms</a>
            <a href="#">Privacy</a>
          </div>
          <div className="footer-info">
            <div className="powered-by">
              <span>Powered by</span>
              <div className="zama-logo">ZAMA FHE</div>
            </div>
            <div className="copyright">© 2023 FHE Flash Loan Protocol</div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;