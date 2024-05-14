import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'isomorphic-fetch';

import fs from 'fs/promises';
import JSBI from 'jsbi';

import { Jupiter, RouteInfo, TOKEN_LIST_URL } from '@jup-ag/core';
import {
  CONSIDER_PI,
  ENV,
  INPUT_MINT_ADDRESS,
  IN_AMOUNT,
  MAX_FEE_PCT,
  MIN_PROFIT,
  MIN_PROFIT_SWAP2_RETRY,
  OUTPUT_MINT_ADDRESS,
  SLIPPAGE,
  SOLANA_RPC_ENDPOINT,
  SWAP2_FAILED_RESET_COUNT,
  Token,
  TX_FEE,
  USER_KEYPAIR,
} from './constants';

// const getPossiblePairsTokenInfo = ({
//   tokens,
//   routeMap,
//   inputToken,
// }: {
//   tokens: Token[];
//   routeMap: Map<string, string[]>;
//   inputToken?: Token;
// }) => {
//   try {
//     if (!inputToken) {
//       return {};
//     }

//     const possiblePairs = inputToken
//       ? routeMap.get(inputToken.address) || []
//       : []; // return an array of token mints that can be swapped with SOL
//     const possiblePairsTokenInfo: { [key: string]: Token | undefined } = {};
//     possiblePairs.forEach((address) => {
//       possiblePairsTokenInfo[address] = tokens.find((t) => {
//         return t.address == address;
//       });
//     });
//     // Perform your conditionals here to use other outputToken
//     // const alternativeOutputToken = possiblePairsTokenInfo[USDT_MINT_ADDRESS]
//     return possiblePairsTokenInfo;
//   } catch (error) {
//     throw error;
//   }
// };



function getLabels(info: RouteInfo) {
  var format: String = '';

  info.marketInfos.forEach(marketInfo => {
    format += `${marketInfo.amm.label} x `;

  });

  return format;
}

function skipInvalidRoutes(infos: RouteInfo[], outputToken: Token) {
  var idx = 0;

  /*infos[idx].priceImpactPct < 0 ||*/
  //infos[idx].priceImpactPct > (SLIPPAGE / 100)
  while (infos[idx].marketInfos.find(mi => mi.platformFee.pct > MAX_FEE_PCT) != null) {
    var outAmount = fromSmallestUnits(JSBI.toNumber(infos[idx].outAmount), outputToken.decimals);
    //console.log(`skipping priceImpactPct: ${infos[idx].priceImpactPct} and price: ${outAmount} by ${getLabels(infos[idx])}`);
    console.log(`skipping because of either PI or platform fee too high`);
    idx++;
  }

  return infos[idx];
}

function toSmallestUnits(input: number, decimals: number) {
  return input * 10 ** decimals;
}

function fromSmallestUnits(input: number, decimals: number) {
  return input / 10 ** decimals;
}


async function getBestRoute({
  jupiter,
  inputToken,
  outputToken,
  inputAmount,
  slippage,
}: {
  jupiter: Jupiter;
  inputToken?: Token;
  outputToken?: Token;
  inputAmount: number;
  slippage: number;
}) {
  try {
    if (!inputToken || !outputToken) {
      return null;
    }

    console.log(`Getting routes for ${inputAmount} ${inputToken.symbol} -> ${outputToken.symbol}...`,);

    const inputAmountInSmallestUnits = inputToken
      ? toSmallestUnits(inputAmount, inputToken.decimals)
      : 0;

    const routes =
      inputToken && outputToken
        ? await jupiter.computeRoutes({
          inputMint: new PublicKey(inputToken.address),
          outputMint: new PublicKey(outputToken.address),
          amount: JSBI.BigInt(inputAmountInSmallestUnits), // raw input amount of tokens
          slippage,
          forceFetch: true,
        })
        : null;

    if (routes == null) {
      return null;
    }
    console.log('Possible number of routes:', routes.routesInfos.length);
    var routeInfo = skipInvalidRoutes(routes.routesInfos, outputToken);
    var outAmount = fromSmallestUnits(JSBI.toNumber(routeInfo.outAmount), outputToken.decimals);
    console.log(`Best quote: ${outAmount} (${outputToken.symbol}) by ${getLabels(routeInfo)}`);

    return routeInfo;
  } catch (error) {
    console.log('error getting route')
  }
};

async function executeSwap({
  jupiter,
  route,
}: {
  jupiter: Jupiter;
  route: RouteInfo;
}) {
  try {
    // Prepare execute exchange
    const { execute } = await jupiter.exchange({
      routeInfo: route
    });

    // Execute swap
    const swapResult: any = await execute(); // Force any to ignore TS misidentifying SwapResult type

    if (swapResult.error) {
      console.log(swapResult.error);
      return false;
    }

    console.log(`https://solscan.io/tx/${swapResult.txid}`);
    console.log(
      `inputAddress=${swapResult.inputAddress.toString()} outputAddress=${swapResult.outputAddress.toString()}`,
    );
    console.log(
      `inputAmount=${swapResult.inputAmount} outputAmount=${swapResult.outputAmount}`,
    );

    return true;

  } catch (error) {
    console.log(error);
    return false;
  }
}


// TODO: remove console.logs as those cost precious miliseconds
async function getBestRouteResult(
  inputAmount: number,
  inputAmountWithoutDecimals: number,
  inputToken: Token,
  outputToken: Token,
  jupiter: Jupiter,
): Promise<bestRouteResult> {
  try {
    const bestRoute = await getBestRoute({
      jupiter,
      inputToken,
      outputToken,
      inputAmount, // 1 unit in UI
      slippage: SLIPPAGE, // 1% slippage
    });

    if (bestRoute == null) {
      throw Error('error finding best route');
    }

    var outAmount = fromSmallestUnits(JSBI.toNumber(bestRoute.outAmount), outputToken.decimals);
    var outAmountWithSlippage = fromSmallestUnits(JSBI.toNumber(bestRoute.outAmount), outputToken.decimals);
    console.log('converting ', inputAmount, `${inputToken.symbol} to `, outAmount, `(${outputToken.symbol})`);

    return { outAmount: outAmount, outAmountWithSlippage: outAmountWithSlippage, route: bestRoute };
  } catch (e) {
    console.log(e);
  }

  return new bestRouteResult();
};

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidResult(toUSD: bestRouteResult) {
  return toUSD != null && toUSD.route != null && toUSD.outAmount != null && toUSD.outAmountWithSlippage != null;
}

class bestRouteResult {
  outAmount: number = 0;
  outAmountWithSlippage: number = 0;
  route: RouteInfo | null | undefined
}


async function main() {
  const connection = new Connection(SOLANA_RPC_ENDPOINT); // Setup Solana RPC connection
  const tokens: Token[] = await (await fetch(TOKEN_LIST_URL[ENV])).json(); // Fetch token list from Jupiter API

  //  Load Jupiter
  const jupiter = await Jupiter.load({
    connection,
    cluster: ENV,
    user: USER_KEYPAIR, // or public key
  });

  //  Get routeMap, which maps each tokenMint and their respective tokenMints that are swappable
  // const routeMap = jupiter.getRouteMap();
  const inputToken = tokens.find((t) => t.address === INPUT_MINT_ADDRESS); // USDC Mint Info
  const outputToken = tokens.find((t) => t.address === OUTPUT_MINT_ADDRESS); // USDT Mint Info

  var swap1FailedIdx = 0;
  var SWAP1_FAILED_DELAY = 5000;
  while (true) {
    // setInterval(async () => {
    if (inputToken != null && outputToken != null) {
      // convert 1 USDC to SOL
      var fromUSD = await getBestRouteResult(IN_AMOUNT, 100000, inputToken, outputToken, jupiter);
      if (fromUSD.outAmount > 0 && fromUSD.route != null) {
        await delay(50);
        // convert back SOL TO USDC
        var toUSD = await getBestRouteResult(fromUSD.outAmount, 0, outputToken, inputToken, jupiter);
        // if we have more than we started with , we did some profit
        console.log(`end amount of ${inputToken.symbol}: ${toUSD.outAmount}`);

        if (toUSD.outAmount > IN_AMOUNT && toUSD.route != null) {
          var grossAmount = toUSD.outAmount - IN_AMOUNT;
          var netAmount = grossAmount - TX_FEE;

          console.log(`GROSS: ${grossAmount} - NET: ${netAmount} at ${new Date().toLocaleString()}`);

          if (netAmount >= MIN_PROFIT) {
            // do the actual swap
            console.log('swap 1');

            var fromUSDSwapResult = await executeSwap({ jupiter: jupiter, route: fromUSD.route });
            if (fromUSDSwapResult == true) {

              console.log('swap 2');

              swap1FailedIdx = 0;

              var toUSDSwapResult = await executeSwap({ jupiter: jupiter, route: toUSD.route });
              var SWAP2_FAILED_DELAY = 1000;
              var swap2FailedIdx = 0;
              while (toUSDSwapResult == false) {

                console.log('swap 2 failed, attempting retry...');

                toUSD = await getBestRouteResult(fromUSD.outAmount, 0, outputToken, inputToken, jupiter);
                if (toUSD.outAmount > IN_AMOUNT && toUSD.route != null) {
                  grossAmount = toUSD.outAmount - IN_AMOUNT;
                  netAmount = grossAmount - TX_FEE;

                  console.log(`GROSS: ${grossAmount} - NET: ${netAmount} at ${new Date().toLocaleString()}`);

                  if (netAmount >= MIN_PROFIT_SWAP2_RETRY) {

                    console.log('swap 2');

                    toUSDSwapResult = await executeSwap({ jupiter: jupiter, route: toUSD.route });
                  }
                }

                var swap2waitTime = SWAP2_FAILED_DELAY * swap2FailedIdx++;
                if (swap2FailedIdx == SWAP2_FAILED_RESET_COUNT) {
                  swap2FailedIdx = 0;
                }
                console.log(`waiting ${swap2waitTime / 1000}s before next swap2 attempt...`);
                await delay(swap2waitTime);
              }
              // log the whole thing to file
              await fs.appendFile('/home/chris/solana_bot.txt', `GROSS: ${grossAmount} - NET: ${netAmount} at ${new Date().toLocaleString()}\n`);

              console.log(`net profit ${netAmount}`);
            } else { // swap 1 has failed 
              swap1FailedIdx++;
            }
          }
        }
      }
    }

    var swap1waitTime = (SWAP1_FAILED_DELAY * swap1FailedIdx);
    console.log(`waiting ${swap1waitTime / 1000}s before next overall attempt...`);
    await delay(swap1waitTime);
  }

  // }, 5000);

  // 0,0001815
  // 1.000306 
  // setInterval(
  //   () => pingSwap(0.001, 100000, inputToken, outputToken, jupiter),
  //   15000,
  // );
  // setInterval(
  //   () => pingSwap(0.01, 1000000, inputToken, outputToken, jupiter),
  //   15000,
  // );
};

main();
