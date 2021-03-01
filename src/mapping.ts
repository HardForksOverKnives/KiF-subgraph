import { BuyToken as BuyTokenEvent, SellToken as SellTokenEvent, Transfer as TransferTokenEvent, Liquid as LiquidContract } from '../generated/Liquid/Liquid'
import { Liquid, LiquidTransaction, LiquidHodlr, LiquidTransfer, TopLiquidHodlr } from '../generated/schema'
import { Address, BigDecimal, BigInt, log, dataSource, ethereum, json, JSONValue, store, Value } from '@graphprotocol/graph-ts'


export const LIQUID_CONTRACT_ADDRESS = "0xC618D56b6D606E59c6B87Af724AB5a91eb40D1cb"
export const LIQUID_FACTORY_ADDRESS = "0x1111111111111111111111111111111111111111"
export const LIQUID_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
export const LIQUID_HODLR_UPDATE_INTERVAL = 7200

function SharedLiquid(): Liquid {
  let liq = Liquid.load(LIQUID_CONTRACT_ADDRESS)
  if (liq == null) {
    liq = new Liquid(LIQUID_CONTRACT_ADDRESS)
    liq.lastHodlrPtsUpdateBlockNumber = BigInt.fromI32(11731586)
    updateLiquidForContract(liq as Liquid)
  }
  return liq as Liquid
}

function updateLiquidForContract(liquid: Liquid): void {
  // log.debug("updateLiquidForContract()", [])

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
    let sellFee = BigDecimal.fromString("0.006")
    let potentialBurns = liquid.circulatingSupply.toBigDecimal().times(sellFee)
    let extraBurns = liqReserve.toBigDecimal().times(potentialBurns).div(liquid.circulatingSupply.toBigDecimal())
    liquid.floorPrice = initialETH.toBigDecimal().div(liquid.totalSupply.toBigDecimal().minus(potentialBurns).minus(extraBurns))
  }
  else {
    liquid.floorPrice = initialETH.toBigDecimal().div(initialLiquid.toBigDecimal())
  }


  liquid.save()
}

/////////////////////////////////////////////////
/////////////////////////////////////////////////
// Buys and Sells

export function handleBuyToken(event: BuyTokenEvent): void {
  let id = event.transaction.hash.toHex()
  addLiquidTransaction(id, event.params.user.toHexString(), event.params.ethAmt.neg(), event.params.tokenAmt, event.block)
}

export function handleSellToken(event: SellTokenEvent): void {
  let id = event.transaction.hash.toHex()
  addLiquidTransaction(id, event.params.user.toHexString(), event.params.ethAmt, event.params.tokenAmt.neg(), event.block)
}

function addLiquidTransaction(id: string, from: string, ethAmt: BigInt, liquidAmt: BigInt, block: ethereum.Block): void {
  // log.debug("addLiquidTransaction()", [])

  if (!shouldTrackActivityForAccount(from)) {
    return
  }

  let transaction = LiquidTransaction.load(id)
  if (transaction == null) {
    let liq = SharedLiquid()
    transaction = new LiquidTransaction(id)
    transaction.address = from
    transaction.ethAmt = ethAmt
    transaction.liquidAmt = liquidAmt
    transaction.blockNumber = block.number
    transaction.timestamp = block.timestamp
    transaction.liquid = liq.id
    transaction.save()

    let hodlr = fetchHodlr(from)
    updateHodlrPointsForHodlr(hodlr, block.number)
    hodlr.save()


    updateLiquidForTransaction(liq, transaction as LiquidTransaction)

    // updates top hodlrs every 7200 blocks (configurable)
    if (shouldUpdateTopHodlrs(liq, block.number)) {
      updateTopHodlrs(block.number)
    }

    if (hodlr.hodlPoints.gt(minimumPtsRequiredForTopHodlrList())) {
      insertNewTopHodlrAtLowestRank(hodlr, block.number)
    }
  }
}

function updateLiquidForTransaction(liquid: Liquid, transaction: LiquidTransaction): void {
  // log.debug("updateLiquidForTransaction()", [])
  updateHodlerBalanceForTransaction(liquid, transaction)
  updateLiquidForContract(liquid)

  liquid.save()
}

// returns true if the minimum number of blocks have passed for a semi-global hodlrPts update to occur
// not sure if necessary, are graph indexers fine with updating all hodlr entities every Liquid event
function shouldUpdateTopHodlrs(liquid: Liquid, currentBlockNumber: BigInt): boolean {
  var shouldUpdate = false

  let blocksSinceLastUpdate = currentBlockNumber.minus(liquid.lastHodlrPtsUpdateBlockNumber)
  if (blocksSinceLastUpdate.ge(BigInt.fromI32(LIQUID_HODLR_UPDATE_INTERVAL))) {
    shouldUpdate = true
  }
  return shouldUpdate
}


/////////////////////////////////////////////////
/////////////////////////////////////////////////
// Transfers

export function handleTransferToken(event: TransferTokenEvent): void {

  let id = event.transaction.hash.toHex()

  let transfer = LiquidTransfer.load(id)
  if (transfer == null) {
    transfer = new LiquidTransfer(id)
    transfer.from = event.params.from.toHexString()
    transfer.to = event.params.to.toHexString()
    transfer.amount = event.params.value
    transfer.liquid = SharedLiquid().id
    transfer.save()

    updateHodlrsForTransfer(transfer as LiquidTransfer, event.block.number)
    // update tophodlrs
    updateLiquidForContract(SharedLiquid())
  }
}

/////////////////////////////////////////////////
/////////////////////////////////////////////////
// Hodlrs

function shouldTrackActivityForAccount(from: string): boolean {
  let shouldTrack = true
  if (from == LIQUID_ZERO_ADDRESS || from == LIQUID_FACTORY_ADDRESS) {
    shouldTrack = false
  }
  return shouldTrack
}

function shouldTrackActivityForAccounts(from: string, to: string): boolean {
  return (shouldTrackActivityForAccount(from) && shouldTrackActivityForAccount(to))
}


function updateHodlerBalanceForTransaction(liquid: Liquid, transaction: LiquidTransaction): void {
  // log.debug("updateHodlerBalanceForTransaction()", [])

  let hodlr = fetchHodlr(transaction.address)
  updateHodlrPointsForHodlr(hodlr, transaction.blockNumber)

  hodlr.balance = hodlr.balance.plus(transaction.liquidAmt)
  if (transaction.liquidAmt.gt(BigInt.fromI32(0))) {
    hodlr.totalBought = hodlr.totalBought.plus(transaction.liquidAmt)
  }
  else {
    hodlr.totalSold = hodlr.totalSold.minus(transaction.liquidAmt)
  }

  hodlr.save()
}

function updateHodlrsForTransfer(transfer: LiquidTransfer, blockNumber: BigInt): void {
  let sender = fetchHodlr(transfer.from)
  let receiver = fetchHodlr(transfer.to)

  updateHodlrPointsForHodlr(sender, blockNumber)
  sender.balance = sender.balance.minus(transfer.amount)
  sender.save()
  updateHodlrPointsForHodlr(receiver, blockNumber)
  receiver.balance = receiver.balance.plus(transfer.amount)
  receiver.save()
}


// PROOF OF LIQUIDITY //
// updates a wallet's hodlPts to the current block
function pendingHodlrPoints(hodlr: LiquidHodlr, toBlock: BigInt): BigDecimal {
  let blocks = toBlock.minus(hodlr.lastBlockUpdate).toBigDecimal()
  return hodlr.balance.toBigDecimal().times(blocks).div(BigDecimal.fromString("0.0000001"))
}

function updateHodlrPointsForHodlr(hodlr: LiquidHodlr, toBlock: BigInt): void {
  hodlr.hodlPoints = hodlr.hodlPoints.plus(pendingHodlrPoints(hodlr, toBlock))
  hodlr.lastBlockUpdate = toBlock
}

// try passing in shared liquid
function fetchHodlr(id: string): LiquidHodlr {
  // log.debug("fetchHodlr()", [])

  let h = LiquidHodlr.load(id)
  if (h == null) {
    h = createHodlr(id)
  }

  return h as LiquidHodlr
}

function createHodlr(id: string): LiquidHodlr {
  let hodlr = new LiquidHodlr(id)

  hodlr.balance = BigInt.fromI32(0)
  hodlr.totalBought = BigInt.fromI32(0)
  hodlr.totalSold = BigInt.fromI32(0)
  hodlr.hodlPoints = BigDecimal.fromString("0.0")
  hodlr.totalTransfered = BigInt.fromI32(0)
  hodlr.liquid = LIQUID_CONTRACT_ADDRESS
  hodlr.lastBlockUpdate = BigInt.fromI32(0)
  
  return hodlr
}


/////////////////////////////////////////////////
/////////////////////////////////////////////////
// Top Hodlrs


// loops through the top hodlrs and updates LiquidHodlr entities
// moves TopHodlr with least hodlPts to 10th rank
function updateTopHodlrs(toBlock: BigInt): void {
  let liq = SharedLiquid()
  var lowestHodlPts: BigDecimal
  var rankOfLowestTopHodlr: number
  
  var i: number
  for (i = 1; i <= 10; i++) {
    let hodlr = fetchHodlrFromTopHodlrRank(i)
    if (hodlr != null) {
      updateHodlrPointsForHodlr(hodlr as LiquidHodlr, toBlock)
      hodlr.save()
      if ((hodlr.hodlPoints.lt(lowestHodlPts)) || (i == 1)) {
        lowestHodlPts = hodlr.hodlPoints
        rankOfLowestTopHodlr = i
      }
    }
  }

  moveTopHodlrToLowestRank(rankOfLowestTopHodlr)
}

function moveTopHodlrToLowestRank(rank: number): void {
  let newLowestRankingTopHodlr = fetchTopLiquidHodlr(rank)
  let newLowestRankingHodlr = fetchHodlrFromTopHodlrRank(rank)
  let oldLowestRankingTopHodlr = fetchTopLiquidHodlr(10)
  let oldLowestRankingHodlr = fetchHodlrFromTopHodlrRank(10)

  if (newLowestRankingHodlr != null && oldLowestRankingHodlr != null && newLowestRankingTopHodlr != null && oldLowestRankingTopHodlr != null) {
    let tempID = newLowestRankingHodlr.id
    newLowestRankingTopHodlr.liquidHodlr = oldLowestRankingHodlr.id
    oldLowestRankingTopHodlr.liquidHodlr = tempID

    newLowestRankingTopHodlr.save()
    oldLowestRankingHodlr.save()
  }
}

function minimumPtsRequiredForTopHodlrList(): BigDecimal {
  var minRequired: BigDecimal
  let hodlr = fetchHodlrFromTopHodlrRank(10)  // 10th place always has the lowest hodlPts (configure later)
  if (hodlr == null) {
    minRequired = BigDecimal.fromString("0.00")
  }
  else {
    minRequired = hodlr.hodlPoints
  }

  return minRequired
}

function insertNewTopHodlrAtLowestRank(hodlr: LiquidHodlr, blockNumber: BigInt): void {
  var topHodlr = fetchTopLiquidHodlr(10)
  if (topHodlr == null) {
    topHodlr = new TopLiquidHodlr("10")
    topHodlr.initiationBlockNumber = blockNumber
  }
  topHodlr.liquidHodlr = hodlr.id
  topHodlr.liquid = SharedLiquid().id

  topHodlr.save()
}

function fetchTopLiquidHodlr(rank: number): TopLiquidHodlr | null {
  return TopLiquidHodlr.load(rank.toString())
}

function fetchHodlrFromTopHodlrRank(rank: number): LiquidHodlr | null {
  let topHodlr = fetchTopLiquidHodlr(rank)
  if (topHodlr == null) {
    return null
  }
  return LiquidHodlr.load(topHodlr.liquidHodlr)
}

