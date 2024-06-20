import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const erc20Module = buildModule("Token", (m) => {
  const name = m.getParameter("name", "tokenName  ");
  const symbol = m.getParameter("symbol", "tokenSymbol");
  const totalSupply = m.getParameter(
    "totalSupply",
    BigInt(21000000000) * BigInt(10) ** BigInt(18)
  );

  const decimals = m.getParameter("decimals", 18);
  const erc20 = m.contract("Token", [totalSupply, name, symbol, decimals], {});

  return { erc20 };
});

export default erc20Module;
