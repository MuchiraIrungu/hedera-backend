// backend/server.js
import dotenv from 'dotenv';
dotenv.config();

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { 
  Client, 
  TokenMintTransaction, 
  TransferTransaction,
  AccountId,
  Hbar,
  PrivateKey,
  TokenId
} from '@hashgraph/sdk';
import express from 'express';
import cors from 'cors';
import { createHiveTokenCollection, mintHiveNFT } from './nft.js';
import fs from 'fs';
import path from 'path';

const app = express();

// ✅ PROPER CORS CONFIGURATION
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL || 'https://your-frontend.onrender.com'
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('Blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

//----------//
// Upload to PINATA
//----------//
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
    return `hive:${metadata.attributes.find(a => a.trait_type === "Hive ID").value}`;
  }
}

//----------//
// Update hive status after sale
//----------//
function markHiveAsSold(hiveId, buyerAccountId, serialNumber) {
  try {
    const hivesPath = path.join(process.cwd(), 'data', 'hives.json');
    const hives = JSON.parse(fs.readFileSync(hivesPath, 'utf8'));
    
    const hiveIndex = hives.findIndex(h => h.id === hiveId);
    if (hiveIndex !== -1) {
      hives[hiveIndex].status = 'sold';
      hives[hiveIndex].owner = buyerAccountId;
      hives[hiveIndex].serialNumber = serialNumber;
      hives[hiveIndex].soldAt = new Date().toISOString();
      
      fs.writeFileSync(hivesPath, JSON.stringify(hives, null, 2));
      console.log(`✓ Marked hive ${hiveId} as sold`);
    }
  } catch (err) {
    console.error('Failed to update hive status:', err);
  }
}

// ✅ HEALTH CHECK ENDPOINT (Required for deployment)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// POST /api/create-token
app.post('/api/create-token', async (req, res) => {
  console.log('CREATE-TOKEN REQUEST RECEIVED');
  try {
    const result = await createHiveTokenCollection();
    if (result.success) {
      res.json({
        success: true,
        tokenId: result.tokenId.toString(),
        supplyKey: result.supplyKey.toString(),
        adminKey: result.adminKey.toString(),
        transactionId: result.transactionId
      });
    } else {
      res.json(result);
    }
  } catch (err) {
    console.error('CREATE ERROR:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mint-nft
app.post('/api/mint-nft', async (req, res) => {
  console.log('MINT-NFT REQUEST RECEIVED', req.body);
  const { tokenId: tokenIdStr, supplyKey: supplyKeyStr, ...hiveMetadata } = req.body;

  if (!tokenIdStr || !supplyKeyStr) {
    return res.status(400).json({ success: false, error: 'Missing tokenId or supplyKey' });
  }

  try {
    console.log('Minting NFT for:', hiveMetadata.name);
    const tokenId = TokenId.fromString(tokenIdStr);
    const supplyKey = PrivateKey.fromString(supplyKeyStr);

    const result = await mintHiveNFT(supplyKey, tokenId, hiveMetadata);
    res.json(result);
  } catch (err) {
    console.error('MINT NFT ERROR:', err);
    res.status(500).json({ success: false, error: err.message || 'Mint failed' });
  }
});

// POST /api/buy-hive - Complete purchase flow
app.post('/api/buy-hive', async (req, res) => {
  const { hiveId, investorAccountId, tokenId: tokenIdStr, supplyKey: supplyKeyStr } = req.body;
  console.log("BUY REQUEST RECEIVED:", req.body);

  try {
    // Validate inputs
    if (!tokenIdStr || !supplyKeyStr || !investorAccountId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: tokenId, supplyKey, or investorAccountId' 
      });
    }

    const tokenId = TokenId.fromString(tokenIdStr);
    const supplyKey = PrivateKey.fromString(supplyKeyStr);
    const buyerAccountId = AccountId.fromString(investorAccountId);
    const treasuryAccountId = AccountId.fromString(process.env.MY_ACCOUNT_ID);
    const treasuryKey = PrivateKey.fromString(process.env.MY_PRIVATE_KEY);

    // Find hive data
    const HIVES = require('./data/hives.json');
    const hive = HIVES.find(h => h.id === hiveId);
    
    if (!hive) {
      return res.status(404).json({ 
        success: false, 
        error: `Hive with id ${hiveId} not found` 
      });
    }

    // Check if already sold
    if (hive.status === 'sold') {
      return res.status(400).json({ 
        success: false, 
        error: 'This hive has already been sold' 
      });
    }

    // Build metadata
    const metadata = {
      name: hive.name,
      description: hive.description,
      image: hive.image,
      attributes: [
        { trait_type: "Hive ID", value: hive.id },
        { trait_type: "Location", value: hive.location },
        { trait_type: "Farmer", value: hive.farmer },
        { trait_type: "Investment", value: `${hive.price} HBAR` },
        { trait_type: "Status", value: "sold" },
        { trait_type: "Owner", value: investorAccountId }
      ]
    };

    // Upload to IPFS
    const ipfsUrl = await uploadToPinata(metadata);
    const metadataBytes = Buffer.from(ipfsUrl);

    if (metadataBytes.length > 100) {
      throw new Error("Metadata too big (max 100 bytes)");
    }

    // Initialize Hedera client
    const client = Client.forTestnet().setOperator(
      process.env.MY_ACCOUNT_ID,
      process.env.MY_PRIVATE_KEY
    );
    client.setDefaultMaxTransactionFee(new Hbar(100));

    // STEP 1: Mint NFT to treasury
    console.log("Step 1: Minting NFT to treasury...");
    const mintTx = new TokenMintTransaction()
      .setTokenId(tokenId)
      .setMetadata([metadataBytes])
      .setMaxTransactionFee(new Hbar(30));

    const mintFrozen = await mintTx.freezeWith(client);
    const mintSigned = await mintFrozen.sign(supplyKey);
    const mintResponse = await mintSigned.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);

    const serial = mintReceipt.serials[0];
    console.log(`✓ Minted NFT #${serial} to treasury`);

    // STEP 2: Transfer NFT from treasury to buyer
    console.log(`Step 2: Transferring NFT #${serial} to buyer ${investorAccountId}...`);
    
    const transferTx = new TransferTransaction()
      .addNftTransfer(tokenId, serial, treasuryAccountId, buyerAccountId)
      .setMaxTransactionFee(new Hbar(30));

    const transferFrozen = await transferTx.freezeWith(client);
    const transferSigned = await transferFrozen.sign(treasuryKey);
    const transferResponse = await transferSigned.execute(client);
    const transferReceipt = await transferResponse.getReceipt(client);

    console.log(`✓ Transfer successful! Status: ${transferReceipt.status.toString()}`);

    // Update database
    markHiveAsSold(hiveId, investorAccountId, serial.toString());

    res.json({
      success: true,
      serialNumber: serial.toString(),
      tokenId: tokenId.toString(),
      explorerUrl: `https://hashscan.io/testnet/token/${tokenId}/${serial}`,
      transactionId: transferResponse.transactionId.toString(),
      message: "NFT minted and transferred to your wallet!"
    });

  } catch (err) {
    console.error("BUY-HIVE ERROR:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Purchase failed' 
    });
  }
});

// GET /api/hive-status/:hiveId - Check hive availability
app.get('/api/hive-status/:hiveId', (req, res) => {
  try {
    const { hiveId } = req.params;
    const HIVES = require('./data/hives.json');
    const hive = HIVES.find(h => h.id === hiveId);
    
    if (!hive) {
      return res.status(404).json({ success: false, error: 'Hive not found' });
    }
    
    res.json({
      success: true,
      hiveId: hive.id,
      status: hive.status,
      isAvailable: hive.status !== 'sold',
      owner: hive.owner || null,
      serialNumber: hive.serialNumber || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ USE PORT FROM ENVIRONMENT (Required for deployment)
const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ API running on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
});