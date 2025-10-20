pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FlashLoanFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct LoanParams {
        euint32 loanAmount;
        euint32 collateralAmount;
        euint32 interestRate;
    }
    mapping(uint256 => LoanParams) public encryptedLoanParams;
    mapping(uint256 => euint32) public encryptedProfitResults;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedStateChanged(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event LoanParamsSubmitted(address indexed provider, uint256 indexed batchId, bytes32 loanAmount, bytes32 collateralAmount, bytes32 interestRate);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 profit);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        paused = false;
        cooldownSeconds = 60;
        currentBatchId = 0;
        batchOpen = false;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedStateChanged(_paused);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        require(newCooldownSeconds > 0, "Cooldown must be positive");
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        require(!batchOpen, "Batch already open");
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        require(batchOpen, "Batch already closed");
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedLoanParams(
        euint32 _loanAmount,
        euint32 _collateralAmount,
        euint32 _interestRate
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        require(batchOpen, "Batch is closed");
        _initIfNeeded(_loanAmount);
        _initIfNeeded(_collateralAmount);
        _initIfNeeded(_interestRate);

        encryptedLoanParams[currentBatchId] = LoanParams({
            loanAmount: _loanAmount,
            collateralAmount: _collateralAmount,
            interestRate: _interestRate
        });
        emit LoanParamsSubmitted(
            msg.sender,
            currentBatchId,
            _loanAmount.toBytes32(),
            _collateralAmount.toBytes32(),
            _interestRate.toBytes32()
        );
    }

    function executeAndRequestDecryption() external onlyProvider whenNotPaused checkDecryptionCooldown {
        require(batchOpen, "Batch is closed");
        LoanParams memory params = encryptedLoanParams[currentBatchId];
        _requireInitialized(params.loanAmount);
        _requireInitialized(params.collateralAmount);
        _requireInitialized(params.interestRate);

        euint32 memory profit = executeFlashLoan(params);
        encryptedProfitResults[currentBatchId] = profit;

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = profit.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedProfitResults[decryptionContexts[requestId].batchId].toBytes32();
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 profit = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, profit);
    }

    function executeFlashLoan(LoanParams memory params) internal pure returns (euint32) {
        euint32 memory revenue = params.loanAmount.mul(params.interestRate);
        euint32 memory profit = revenue.sub(params.collateralAmount);
        return profit;
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!x.isInitialized()) {
            x = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 x) internal pure {
        if (!x.isInitialized()) {
            revert NotInitialized();
        }
    }
}