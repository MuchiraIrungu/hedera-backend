import dotenv from 'dotenv';
dotenv.config();

import {
    Client,
    PrivateKey,
    TokenCreateTransaction,
    TokenType,
    TokenSupplyType,
    Hbar,
    AccountCreateTransaction,
    TokenMintTransaction,
} from "@hashgraph/sdk";

import {PinataSDK} from 'pinata'

// ==========================================
// Environment setup
// ==========================================
const operatorId = process.env.MY_ACCOUNT_ID;
const operatorKey = process.env.MY_PRIVATE_KEY;
const pinata  = new PinataSDK({
    pinataJwtKey: process.env.PINATA_JWT,
    pinataGateway:process.env.PINATA_GATEWAY,
})

// Validate JWT
if (!process.env.PINATA_JWT) {
    throw new Error("PINATA_JWT missing in .env — get from pinata.cloud");
}

if (!operatorId || !operatorKey) {
    throw new Error("MY_ACCOUNT_ID and MY_PRIVATE_KEY must be in .env");
}

const client = Client.forTestnet();
client.setOperator(operatorId, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(100));
client.setMaxQueryPayment(new Hbar(50));

//Configure storage
async function uploadToPinata(metadata) {
  try {
    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.PINATA_JWT}`
      },
      body: JSON.stringify({
        pinataMetadata: { name: `Ecolive Hive #${metadata.attributes[0].value}` },
        pinataContent: metadata
      })
    });

    const data = await response.json();

    if (!data.IpfsHash) throw new Error("Pinata failed");

    const ipfsUrl = `ipfs://${data.IpfsHash}`;
    console.log("IPFS UPLOAD SUCCESS:", ipfsUrl);
    return ipfsUrl;

  } catch (err) {
    console.warn("Pinata failed → using fallback metadata");
    // Fallback: Use on-chain fallback
    return `hive:${metadata.attributes.find(a => a.trait_type === "Hive ID").value}`;
  }
}

// ==========================================
// TOKEN CREATION FUNCTION
// ==========================================
export async function createHiveTokenCollection() {
    try {
        console.log('\nCreating NFT Collection...');

        const supplyKey = PrivateKey.generate();
        const adminKey = PrivateKey.generate();

        const tokenCreateTx = new TokenCreateTransaction()
            .setTokenName("Ecolive Hives")
            .setTokenSymbol("HIVE")
            .setTokenType(TokenType.NonFungibleUnique)
            .setDecimals(0)
            .setInitialSupply(0)
            .setTreasuryAccountId(operatorId)
            .setSupplyType(TokenSupplyType.Infinite)
            //.setMaxSupply(250)
            .setSupplyKey(supplyKey)
            .setAdminKey(adminKey)
            .setMaxTransactionFee(new Hbar(20))
            .freezeWith(client);

        let signedTx = await tokenCreateTx.sign(PrivateKey.fromString(operatorKey));
        signedTx = await signedTx.sign(adminKey)
        const txResponse = await signedTx.execute(client);
        const receipt = await txResponse.getReceipt(client);
        const tokenId = receipt.tokenId;

        console.log(`Created NFT Collection: ${tokenId.toString()}`);
        console.log(`Explorer: https://hashscan.io/testnet/token/${tokenId.toString()}`);
        console.log(`SUPPLY KEY (SAVE!): ${supplyKey.toString()}`);
        console.log(`ADMIN KEY (SAVE!): ${adminKey.toString()}`);

        return {
            success: true,
            tokenId,
            supplyKey,
            adminKey,
            transactionId: txResponse.transactionId.toString()
        };
    } catch (error) {
        console.error("Token creation failed:", error.message);
        return { success: false, error: error.message };
    }
}

// ==========================================
// MINT INDIVIDUAL HIVE NFT
// ==========================================
export async function mintHiveNFT(supplyKey,tokenId,hiveMetadata) {
    if (!tokenId || !supplyKey) {
        throw new Error("Token not created yet. Run createHiveTokenCollection() first.");
    }

    try {
        console.log('\nMinting NFT...');
        console.log('Token ID:', tokenId.toString());

        //prepare metadata
        const fullMetadata = {
            name: hiveMetadata.name || 'Ecolive Hive',
            description: hiveMetadata.description || 'Beehive investment NFT',
            image: hiveMetadata.imageURL || 'https://via.placeholder.com/400x300?text=Beehive',
            attributes: [  // OpenSea-compatible
                { trait_type: 'Hive ID', value: hiveMetadata.hiveId || 'HIVE-001' },
                { trait_type: 'Location', value: hiveMetadata.location || 'Nairobi, Kenya' },
                { trait_type: 'Farmer', value: hiveMetadata.farmer || 'John Doe' },
                { trait_type: 'Investment', value: `$${hiveMetadata.investmentAmount || 5000}` },
                { trait_type: 'Status', value: `$${hiveMetadata.status || 'active'}` }
            ]
        };
        console.log('Full Metadata:', JSON.stringify(fullMetadata, null, 2));

        //upload to IPFS to get CID
        const ipfsURL = await uploadToPinata(fullMetadata);
        console.log('Uploaded to IPFS: ', ipfsURL);

        const metadata = Buffer.from(ipfsURL);
        console.log(`Hedera metadata: "${ipfsURL}" (${metadata.length} bytes)`);

        if (metadata.length > 100) {
            throw new Error(`Metadata too long: ${metadata.length} bytes`);
        }

        const mintTx = new TokenMintTransaction()
            .setTokenId(tokenId)
            .setMetadata([metadata])
            .setMaxTransactionFee(new Hbar(20));

        const frozenTx = await mintTx.freezeWith(client);
        const signedTx = await frozenTx.sign(supplyKey);  // ← Now in scope!

        console.log('Executing mint...');
        const mintResponse = await signedTx.execute(client);
        const receipt = await mintResponse.getReceipt(client);

        const serial = receipt.serials[0];

        console.log(`Minted NFT #${serial}`);
        console.log(`View: https://hashscan.io/testnet/token/${tokenId.toString()}/${serial}`);

        return {
            success: true,
            serialNumber: serial.toString(),
            tokenId: tokenId.toString(),
            ipfsURL,
            explorerUrl: `https://hashscan.io/testnet/token/${tokenId}/${serial}`
        };
    } catch (error) {
        console.error("Mint failed:", error.message);
        return { success: false, error: error.message };
    }
}


/*
// ==========================================
// MAIN: Run step-by-step
// ==========================================
async function main() {
    console.log("Starting token creation on Hedera Testnet...");

    // Optional: Create a test account first
    const newAccountPrivateKey = PrivateKey.generateED25519();
    const newAccountPublicKey = newAccountPrivateKey.publicKey;

    const createTx = new AccountCreateTransaction()
        .setKey(newAccountPublicKey)
        .setInitialBalance(Hbar.fromTinybars(1000));

    const createResponse = await createTx.execute(client);
    const createReceipt = await createResponse.getReceipt(client);
    const newAccountId = createReceipt.accountId;

    console.log(`New test account created: ${newAccountId}`);
    console.log(`Private Key (save this!): ${newAccountPrivateKey.toString()}`);

    // Now create token
    const result = await createHiveTokenCollection();
    console.log("Result:", result);

    if(result){
        const sampleMetadata = {
            name: "Golden Hive #1",
            description: "Premium beehive in Nairobi",
            imageURL: "https://example.com/hive1.jpg",
            hiveId: "HIVE-001",
            location: "Nairobi, Kenya",
            farmer: "Jane Kamau",
            investmentAmount: 10000
        };

        const mintToken = await mintHiveNFT(
            result.supplyKey,
            result.tokenId,
            sampleMetadata);
        console.log('Minted Hive NfT Result: ', mintToken)
    }

}

main().catch(err => {
    console.error("Script failed:", err);
    process.exit(1);
}); */