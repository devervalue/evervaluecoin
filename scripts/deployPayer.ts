import hre from "hardhat";
import payerModule from "../ignition/modules/Payer";
async function main() {
  const { payer } = await hre.ignition.deploy(payerModule);
  const addrPayer = (await payer.getAddress()).toLocaleLowerCase();

  // Verify the contracts
  await hre.run("verify:verify", {
    address: addrPayer,
    constructorArguments: [
      "0x3a174E2317F657521fd54E296391fC65E883F5c8",
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      "0xA89d65deF0A001947d8D5fDda93F9C4f8453902e",
    ],
  });

  console.log("Everything deployed...");
  console.log({ addrPayer });
}

main().catch(console.error);
