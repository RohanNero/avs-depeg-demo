// SPDX-License-Identifier: GNU
pragma solidity ^0.8.9;

interface IDepegServiceManager {
    event NewTaskCreated(uint32 indexed taskIndex, Task task);

    event TaskResponded(uint32 indexed taskIndex, Task task, address operator);

    /**@notice Task object containing data specific to this AVS implementation */
    struct Task {
        address token; // ERC-20 stablecoin address
        uint40 startTimestamp; // Starting timestamp of depeg
        uint40 endTimestamp; // Ending timestamp of depeg
        // string[] sources; // Where the price data came from, could be URLs
        uint32 taskCreatedBlock; // Block at which the task was created
    }

    function latestTaskNum() external view returns (uint32);

    function allTaskHashes(uint32 taskIndex) external view returns (bytes32);

    function allTaskResponses(
        address operator,
        uint32 taskIndex
    ) external view returns (bytes memory);

    function createNewTask(
        address token,
        uint40 startTimestamp,
        uint40 endTimestamp
    )
        external
        returns (
            // string[] memory sources
            Task memory
        );

    function respondToTask(
        Task calldata task,
        uint32 referenceTaskIndex,
        bytes calldata signature
    ) external;
}
