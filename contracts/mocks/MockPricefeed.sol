// SPDX-License-Identifier: MIT

import {ERC20} from "forge-std/mocks/MockERC20.sol";

pragma solidity ^0.8.0;

/**@notice Returns a mock USD-pegged price
 * @dev If the timestamp is between 1732252000-1732253000, return the price
 */
contract MockPricefeed is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
}
