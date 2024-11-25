// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.12;

import {DepegServiceManager} from "../src/DepegServiceManager.sol";
import {MockAVSDeployer} from "@eigenlayer-middleware/test/utils/MockAVSDeployer.sol";
import {ECDSAStakeRegistry} from "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/Test.sol";
import {DepegDeploymentLib} from "../script/utils/DepegDeploymentLib.sol";
import {CoreDeploymentLib} from "../script/utils/CoreDeploymentLib.sol";
import {UpgradeableProxyLib} from "../script/utils/UpgradeableProxyLib.sol";
import {ERC20Mock} from "./ERC20Mock.sol";
import {IERC20, StrategyFactory} from "@eigenlayer/contracts/strategies/StrategyFactory.sol";

import {Quorum, StrategyParams, IStrategy} from "@eigenlayer-middleware/src/interfaces/IECDSAStakeRegistryEventsAndErrors.sol";
import {IStrategyManager} from "@eigenlayer/contracts/interfaces/IStrategyManager.sol";
import {IDelegationManager} from "@eigenlayer/contracts/interfaces/IDelegationManager.sol";
import {ISignatureUtils} from "@eigenlayer/contracts/interfaces/ISignatureUtils.sol";
import {AVSDirectory} from "@eigenlayer/contracts/core/AVSDirectory.sol";
import {IAVSDirectory} from "@eigenlayer/contracts/interfaces/IAVSDirectory.sol";
import {Test, console2 as console} from "forge-std/Test.sol";
import {IDepegServiceManager} from "../src/IDepegServiceManager.sol";
import {ECDSAUpgradeable} from "@openzeppelin-upgrades/contracts/utils/cryptography/ECDSAUpgradeable.sol";

contract DepegTaskManagerSetup is Test {
    Quorum internal quorum;

    struct Operator {
        Vm.Wallet key;
        Vm.Wallet signingKey;
    }

    struct TrafficGenerator {
        Vm.Wallet key;
    }

    Operator[] internal operators;
    TrafficGenerator internal generator;

    DepegDeploymentLib.DeploymentData internal depegDeployment;
    CoreDeploymentLib.DeploymentData internal coreDeployment;
    CoreDeploymentLib.DeploymentConfigData coreConfigData;

    ERC20Mock public mockToken;

    mapping(address => IStrategy) public tokenToStrategy;

    function setUp() public virtual {
        generator = TrafficGenerator({
            key: vm.createWallet("generator_wallet")
        });

        address proxyAdmin = UpgradeableProxyLib.deployProxyAdmin();

        coreConfigData = CoreDeploymentLib.readDeploymentConfigValues(
            "test/mockData/config/core/",
            1337
        ); // TODO: Fix this to correct path
        coreDeployment = CoreDeploymentLib.deployContracts(
            proxyAdmin,
            coreConfigData
        );

        mockToken = new ERC20Mock();

        IStrategy strategy = addStrategy(address(mockToken));
        quorum.strategies.push(
            StrategyParams({strategy: strategy, multiplier: 10_000})
        );

        depegDeployment = DepegDeploymentLib.deployContracts(
            proxyAdmin,
            coreDeployment,
            quorum
        );
        labelContracts(coreDeployment, depegDeployment);
    }

    function addStrategy(address token) public returns (IStrategy) {
        if (tokenToStrategy[token] != IStrategy(address(0))) {
            return tokenToStrategy[token];
        }

        StrategyFactory strategyFactory = StrategyFactory(
            coreDeployment.strategyFactory
        );
        IStrategy newStrategy = strategyFactory.deployNewStrategy(
            IERC20(token)
        );
        tokenToStrategy[token] = newStrategy;
        return newStrategy;
    }

    function labelContracts(
        CoreDeploymentLib.DeploymentData memory coreDeployment,
        DepegDeploymentLib.DeploymentData memory depegDeployment
    ) internal {
        vm.label(coreDeployment.delegationManager, "DelegationManager");
        vm.label(coreDeployment.avsDirectory, "AVSDirectory");
        vm.label(coreDeployment.strategyManager, "StrategyManager");
        vm.label(coreDeployment.eigenPodManager, "EigenPodManager");
        vm.label(coreDeployment.rewardsCoordinator, "RewardsCoordinator");
        vm.label(coreDeployment.eigenPodBeacon, "EigenPodBeacon");
        vm.label(coreDeployment.pauserRegistry, "PauserRegistry");
        vm.label(coreDeployment.strategyFactory, "StrategyFactory");
        vm.label(coreDeployment.strategyBeacon, "StrategyBeacon");
        vm.label(depegDeployment.depegServiceManager, "DepegServiceManager");
        vm.label(depegDeployment.stakeRegistry, "StakeRegistry");
    }

    function signWithOperatorKey(
        Operator memory operator,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            operator.key.privateKey,
            digest
        );
        return abi.encodePacked(r, s, v);
    }

    function signWithSigningKey(
        Operator memory operator,
        bytes32 digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            operator.signingKey.privateKey,
            digest
        );
        return abi.encodePacked(r, s, v);
    }

    function mintMockTokens(Operator memory operator, uint256 amount) internal {
        mockToken.mint(operator.key.addr, amount);
    }

    function depositTokenIntoStrategy(
        Operator memory operator,
        address token,
        uint256 amount
    ) internal returns (uint256) {
        IStrategy strategy = IStrategy(tokenToStrategy[token]);
        require(address(strategy) != address(0), "Strategy was not found");
        IStrategyManager strategyManager = IStrategyManager(
            coreDeployment.strategyManager
        );

        vm.startPrank(operator.key.addr);
        mockToken.approve(address(strategyManager), amount);
        uint256 shares = strategyManager.depositIntoStrategy(
            strategy,
            IERC20(token),
            amount
        );
        vm.stopPrank();

        return shares;
    }

    function registerAsOperator(Operator memory operator) internal {
        IDelegationManager delegationManager = IDelegationManager(
            coreDeployment.delegationManager
        );

        IDelegationManager.OperatorDetails
            memory operatorDetails = IDelegationManager.OperatorDetails({
                __deprecated_earningsReceiver: operator.key.addr,
                delegationApprover: address(0),
                stakerOptOutWindowBlocks: 0
            });

        vm.prank(operator.key.addr);
        delegationManager.registerAsOperator(operatorDetails, "");
    }

    function registerOperatorToAVS(Operator memory operator) internal {
        ECDSAStakeRegistry stakeRegistry = ECDSAStakeRegistry(
            depegDeployment.stakeRegistry
        );
        AVSDirectory avsDirectory = AVSDirectory(coreDeployment.avsDirectory);

        bytes32 salt = keccak256(
            abi.encodePacked(block.timestamp, operator.key.addr)
        );
        uint256 expiry = block.timestamp + 1 hours;

        bytes32 operatorRegistrationDigestHash = avsDirectory
            .calculateOperatorAVSRegistrationDigestHash(
                operator.key.addr,
                address(depegDeployment.depegServiceManager),
                salt,
                expiry
            );

        bytes memory signature = signWithOperatorKey(
            operator,
            operatorRegistrationDigestHash
        );

        ISignatureUtils.SignatureWithSaltAndExpiry
            memory operatorSignature = ISignatureUtils
                .SignatureWithSaltAndExpiry({
                    signature: signature,
                    salt: salt,
                    expiry: expiry
                });

        vm.prank(address(operator.key.addr));
        stakeRegistry.registerOperatorWithSignature(
            operatorSignature,
            operator.signingKey.addr
        );
    }

    function deregisterOperatorFromAVS(Operator memory operator) internal {
        ECDSAStakeRegistry stakeRegistry = ECDSAStakeRegistry(
            depegDeployment.stakeRegistry
        );

        vm.prank(operator.key.addr);
        stakeRegistry.deregisterOperator();
    }

    function createAndAddOperator() internal returns (Operator memory) {
        Vm.Wallet memory operatorKey = vm.createWallet(
            string.concat("operator", vm.toString(operators.length))
        );
        Vm.Wallet memory signingKey = vm.createWallet(
            string.concat("signing", vm.toString(operators.length))
        );

        Operator memory newOperator = Operator({
            key: operatorKey,
            signingKey: signingKey
        });

        operators.push(newOperator);
        return newOperator;
    }

    function updateOperatorWeights(Operator[] memory _operators) internal {
        ECDSAStakeRegistry stakeRegistry = ECDSAStakeRegistry(
            depegDeployment.stakeRegistry
        );

        address[] memory operatorAddresses = new address[](_operators.length);
        for (uint256 i = 0; i < _operators.length; i++) {
            operatorAddresses[i] = _operators[i].key.addr;
        }

        stakeRegistry.updateOperators(operatorAddresses);
    }

    function getSortedOperatorSignatures(
        Operator[] memory _operators,
        bytes32 digest
    ) internal pure returns (bytes[] memory) {
        uint256 length = _operators.length;
        bytes[] memory signatures = new bytes[](length);
        address[] memory addresses = new address[](length);

        for (uint256 i = 0; i < length; i++) {
            addresses[i] = _operators[i].key.addr;
            signatures[i] = signWithOperatorKey(_operators[i], digest);
        }

        for (uint256 i = 0; i < length - 1; i++) {
            for (uint256 j = 0; j < length - i - 1; j++) {
                if (addresses[j] > addresses[j + 1]) {
                    // Swap addresses
                    address tempAddr = addresses[j];
                    addresses[j] = addresses[j + 1];
                    addresses[j + 1] = tempAddr;

                    // Swap signatures
                    bytes memory tempSig = signatures[j];
                    signatures[j] = signatures[j + 1];
                    signatures[j + 1] = tempSig;
                }
            }
        }

        return signatures;
    }

    /**@notice Creates a string array with sources for the price depeg */
    function createSources() internal pure returns (string[] memory) {
        string[] memory sources;
        sources[0] = "https://coinmarketcap.com/currencies/usd-coin/";
        return sources;
    }

    /**@notice Returns the task data to be sent to `createNewTask()` */
    function getTaskData()
        public
        pure
        returns (address, uint40, uint40, string[] memory)
    {
        address token = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        uint40 startTimestamp = uint40(1732252000);
        uint40 endTimestamp = uint40(1732253000);
        string[] memory sources = createSources();
        return (token, startTimestamp, endTimestamp, sources);
    }

    function createTask(
        TrafficGenerator memory generator,
        address token,
        uint40 startTimestamp,
        uint40 endTimestamp,
        string[] memory sources
    ) internal {
        IDepegServiceManager depegServiceManager = IDepegServiceManager(
            depegDeployment.depegServiceManager
        );

        vm.prank(generator.key.addr);
        depegServiceManager.createNewTask(
            token,
            startTimestamp,
            endTimestamp,
            sources
        );
    }

    function respondToTask(
        Operator memory operator,
        IDepegServiceManager.Task memory task,
        uint32 referenceTaskIndex
    ) internal {
        // Create the message hash
        bytes32 messageHash = keccak256(
            abi.encodePacked(task.token, task.startTimestamp, task.endTimestamp)
        );

        bytes memory signature = signWithSigningKey(operator, messageHash);

        address[] memory operators = new address[](1);
        operators[0] = operator.key.addr;
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = signature;

        bytes memory signedTask = abi.encode(
            operators,
            signatures,
            uint32(block.number)
        );

        IDepegServiceManager(depegDeployment.depegServiceManager).respondToTask(
                task,
                referenceTaskIndex,
                signedTask
            );
    }
}

contract DepegServiceManagerInitialization is DepegTaskManagerSetup {
    function testInitialization() public view {
        ECDSAStakeRegistry stakeRegistry = ECDSAStakeRegistry(
            depegDeployment.stakeRegistry
        );

        Quorum memory quorum = stakeRegistry.quorum();

        assertGt(quorum.strategies.length, 0, "No strategies in quorum");
        assertEq(
            address(quorum.strategies[0].strategy),
            address(tokenToStrategy[address(mockToken)]),
            "First strategy doesn't match mock token strategy"
        );

        assertTrue(
            depegDeployment.stakeRegistry != address(0),
            "StakeRegistry not deployed"
        );
        assertTrue(
            depegDeployment.depegServiceManager != address(0),
            "DepegServiceManager not deployed"
        );
        assertTrue(
            coreDeployment.delegationManager != address(0),
            "DelegationManager not deployed"
        );
        assertTrue(
            coreDeployment.avsDirectory != address(0),
            "AVSDirectory not deployed"
        );
        assertTrue(
            coreDeployment.strategyManager != address(0),
            "StrategyManager not deployed"
        );
        assertTrue(
            coreDeployment.eigenPodManager != address(0),
            "EigenPodManager not deployed"
        );
        assertTrue(
            coreDeployment.strategyFactory != address(0),
            "StrategyFactory not deployed"
        );
        assertTrue(
            coreDeployment.strategyBeacon != address(0),
            "StrategyBeacon not deployed"
        );
    }
}

contract RegisterOperator is DepegTaskManagerSetup {
    uint256 internal constant INITIAL_BALANCE = 100 ether;
    uint256 internal constant DEPOSIT_AMOUNT = 1 ether;
    uint256 internal constant OPERATOR_COUNT = 4;

    IDelegationManager internal delegationManager;
    AVSDirectory internal avsDirectory;
    IDepegServiceManager internal sm;
    ECDSAStakeRegistry internal stakeRegistry;

    function setUp() public virtual override {
        super.setUp();
        /// Setting to internal state for convenience
        delegationManager = IDelegationManager(
            coreDeployment.delegationManager
        );
        avsDirectory = AVSDirectory(coreDeployment.avsDirectory);
        sm = IDepegServiceManager(depegDeployment.depegServiceManager);
        stakeRegistry = ECDSAStakeRegistry(depegDeployment.stakeRegistry);

        addStrategy(address(mockToken));

        while (operators.length < OPERATOR_COUNT) {
            createAndAddOperator();
        }

        for (uint256 i = 0; i < OPERATOR_COUNT; i++) {
            mintMockTokens(operators[i], INITIAL_BALANCE);

            depositTokenIntoStrategy(
                operators[i],
                address(mockToken),
                DEPOSIT_AMOUNT
            );

            registerAsOperator(operators[i]);
        }
    }

    function testVerifyOperatorStates() public view {
        for (uint256 i = 0; i < OPERATOR_COUNT; i++) {
            address operatorAddr = operators[i].key.addr;

            uint256 operatorShares = delegationManager.operatorShares(
                operatorAddr,
                tokenToStrategy[address(mockToken)]
            );
            assertEq(
                operatorShares,
                DEPOSIT_AMOUNT,
                "Operator shares in DelegationManager incorrect"
            );
        }
    }

    function test_RegisterOperatorToAVS() public {
        address operatorAddr = operators[0].key.addr;
        registerOperatorToAVS(operators[0]);
        assertTrue(
            avsDirectory.avsOperatorStatus(address(sm), operatorAddr) ==
                IAVSDirectory.OperatorAVSRegistrationStatus.REGISTERED,
            "Operator not registered in AVSDirectory"
        );

        address signingKey = stakeRegistry.getLastestOperatorSigningKey(
            operatorAddr
        );
        assertTrue(
            signingKey != address(0),
            "Operator signing key not set in ECDSAStakeRegistry"
        );

        uint256 operatorWeight = stakeRegistry.getLastCheckpointOperatorWeight(
            operatorAddr
        );
        assertTrue(
            operatorWeight > 0,
            "Operator weight not set in ECDSAStakeRegistry"
        );
    }
}

contract CreateTask is DepegTaskManagerSetup {
    IDepegServiceManager internal sm;

    function setUp() public override {
        super.setUp();
        sm = IDepegServiceManager(depegDeployment.depegServiceManager);
    }

    /**@notice Create the task with the DepegServiceManager's `createNewTask()`
     * @dev Uses same mock data as `operator/createNewTask.ts`'s `generateTaskData()` */
    function testCreateTask() public {
        address token = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        uint40 startTimestamp = uint40(1732252000);
        uint40 endTimestamp = uint40(1732253000);
        string[] memory sources = createSources();

        vm.prank(generator.key.addr);
        IDepegServiceManager.Task memory newTask = sm.createNewTask(
            token,
            startTimestamp,
            endTimestamp,
            sources
        );
    }
}

contract RespondToTask is DepegTaskManagerSetup {
    using ECDSAUpgradeable for bytes32;

    uint256 internal constant INITIAL_BALANCE = 100 ether;
    uint256 internal constant DEPOSIT_AMOUNT = 1 ether;
    uint256 internal constant OPERATOR_COUNT = 4;

    IDelegationManager internal delegationManager;
    AVSDirectory internal avsDirectory;
    IDepegServiceManager internal sm;
    ECDSAStakeRegistry internal stakeRegistry;

    function setUp() public override {
        super.setUp();

        delegationManager = IDelegationManager(
            coreDeployment.delegationManager
        );
        avsDirectory = AVSDirectory(coreDeployment.avsDirectory);
        sm = IDepegServiceManager(depegDeployment.depegServiceManager);
        stakeRegistry = ECDSAStakeRegistry(depegDeployment.stakeRegistry);

        addStrategy(address(mockToken));

        while (operators.length < OPERATOR_COUNT) {
            createAndAddOperator();
        }

        for (uint256 i = 0; i < OPERATOR_COUNT; i++) {
            mintMockTokens(operators[i], INITIAL_BALANCE);

            depositTokenIntoStrategy(
                operators[i],
                address(mockToken),
                DEPOSIT_AMOUNT
            );

            registerAsOperator(operators[i]);

            registerOperatorToAVS(operators[i]);
        }
    }

    function testRespondToTask() public {
        (
            address token,
            uint40 startTime,
            uint40 endTime,
            string[] memory sources
        ) = this.getTaskData();
        IDepegServiceManager.Task memory newTask = sm.createNewTask(
            token,
            startTime,
            endTime,
            sources
        );
        uint32 taskIndex = sm.latestTaskNum() - 1;

        bytes32 messageHash = keccak256(
            abi.encodePacked(token, startTime, endTime)
        );
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        bytes memory signature = signWithSigningKey(
            operators[0],
            ethSignedMessageHash
        ); // TODO: Use signing key after changes to service manager

        address[] memory operatorsMem = new address[](1);
        operatorsMem[0] = operators[0].key.addr;
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = signature;

        bytes memory signedTask = abi.encode(
            operatorsMem,
            signatures,
            uint32(block.number)
        );

        vm.roll(block.number + 1);
        sm.respondToTask(newTask, taskIndex, signedTask);
    }
}
