import { BuyToken as BuyTokenEvent, SellToken as SellTokenEvent, Liquid as LiquidContract } from '../generated/Liquid/Liquid'
import { Liquid, LiquidTransaction, LiquidHodler } from '../generated/schema'
import { Address, BigDecimal, BigInt, dataSource, ethereum, json, JSONValue, store, Value } from '@graphprotocol/graph-ts'

export const LIQUID_CONTRACT_ADDRESS = "0xC618D56b6D606E59c6B87Af724AB5a91eb40D1cb"

export function handleBuyToken(event: BuyTokenEvent): void {
  let id = event.transaction.hash.toHex()
  addLiquidTransaction(id, event.params.user, event.params.ethAmt.neg(), event.params.tokenAmt, event.block)
}

export function handleSellToken(event: SellTokenEvent): void {
  let id = event.transaction.hash.toHex()
  addLiquidTransaction(id, event.params.user, event.params.ethAmt, event.params.tokenAmt.neg(), event.block)
}

function addLiquidTransaction(id: string, from: Address, ethAmt: BigInt, liquidAmt: BigInt, block: ethereum.Block): void {
  let transaction = LiquidTransaction.load(id)
  if (transaction == null) {
    let liq = SharedLiquid()
    transaction = new LiquidTransaction(id)
    transaction.address = from
    transaction.ethAmt = ethAmt
    transaction.liquidAmt = liquidAmt
    transaction.blockNumber = block.number
    transaction.timestamp = block.timestamp
    transaction.save()

    updateLiquidForTransaction(liq as Liquid, transaction as LiquidTransaction)
  }
}


function SharedLiquid(): Liquid {
  let liq = Liquid.load(LIQUID_CONTRACT_ADDRESS)
  if (liq == null) {
    liq = new Liquid(LIQUID_CONTRACT_ADDRESS)
    liq.hodlrs = []
    liq.transactions = []
    liq.lastBlockUpdate = BigInt.fromI32(1)
    updateLiquidForContract(liq as Liquid)
  }
  return liq as Liquid
}

function updateLiquidForTransaction(liquid: Liquid, transaction: LiquidTransaction): void {
  liquid.transactions.push(transaction.id)

  updateAllHodlrPts(liquid, transaction.blockNumber)

  let fromAddress = transaction.address.toHexString()
  if (liquid.hodlrs.includes(fromAddress) == false) {
    liquid.hodlrs.push(fromAddress)
  }
  updateHodlerForTransaction(transaction)
  updateLiquidForContract(liquid)
}

function updateLiquidForContract(liquid: Liquid): void {
  let contract = LiquidContract.bind(Address.fromString(LIQUID_CONTRACT_ADDRESS))
  liquid.totalSupply = contract.totalSupply()
  let ethReserve = contract.getEthReserve()
  let liqReserve = contract.getTokenReserve()
  let initialETH = contract.INITIAL_EthReserve()
  let initialLiquid = contract.INITIAL_TokenReserve()
  liquid.burnedSupply = initialLiquid.minus(liquid.totalSupply)
  liquid.circulatingSupply = liquid.totalSupply.minus(liqReserve)
  liquid.etherLocked = ethReserve.minus(initialETH)
  liquid.price = ethReserve.toBigDecimal().div(liqReserve.toBigDecimal())

  if (liquid.burnedSupply.gt(BigInt.fromI32(0))) {
    let initialETHD = initialLiquid.toBigDecimal()
    let sellFee = BigDecimal.fromString("0.006")
    let potentialBurns = liquid.circulatingSupply.toBigDecimal().times(sellFee)
    liquid.floorPrice = initialETH.toBigDecimal().div(liquid.totalSupply.toBigDecimal().minus(potentialBurns))
  }
  else {
    liquid.floorPrice = initialETH.toBigDecimal().div(initialLiquid.toBigDecimal())
  }
  liquid.save()
}

function updateHodlerForTransaction(transaction: LiquidTransaction): LiquidHodler {
  let hodlr = fetchHodlr(transaction.address.toHexString())

  if (transaction.liquidAmt.gt(BigInt.fromI32(0))) {
    hodlr.balance = hodlr.balance.plus(transaction.liquidAmt)
    hodlr.totalBought = hodlr.totalBought.plus(transaction.liquidAmt)
  }
  else {
    hodlr.balance = hodlr.balance.minus(transaction.liquidAmt)
    hodlr.totalSold = hodlr.totalSold.plus(transaction.liquidAmt)
  }

  hodlr.save()
  return hodlr
}

// PROOF OF LIQUIDITY
// for every hodlr, award 1 pt per block held since the last update
function updateAllHodlrPts(liquid: Liquid, toBlock: BigInt): void {

  liquid.hodlrs.forEach((hodlrID) => {
    let hodlr = fetchHodlr(hodlrID)
    let pts = hodlr.balance.times(toBlock.minus(liquid.lastBlockUpdate))
    hodlr.hodlPoints = hodlr.hodlPoints.plus(pts.toBigDecimal().times(BigDecimal.fromString("0.001")))
    hodlr.save()
  });

}

function fetchHodlr(id: string): LiquidHodler {
  let h = LiquidHodler.load(id)
  if (h == null) {
    h = createHodlr(id)
  }

  return h as LiquidHodler
}

function createHodlr(id: string): LiquidHodler {
  let hodlr = new LiquidHodler(id)

  hodlr.balance = BigInt.fromI32(0)
  hodlr.totalBought = BigInt.fromI32(0)
  hodlr.totalSold = BigInt.fromI32(0)
  hodlr.hodlPoints = BigDecimal.fromString("0.0")
  hodlr.totalTransfered = BigInt.fromI32(0)
  
  return hodlr
}