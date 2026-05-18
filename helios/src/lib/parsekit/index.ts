/**
 * @freshly-baked/parsekit (isomorphic public surface)
 *
 * Worker-side wiring (release loader, fs.watch, git ops, page-dave)
 * lives in ./node/. The browser and the worker share everything else.
 */

export * from './types.js'
export { compileExpr, type CaptureNode } from './compile.js'
export { compileParser, parseWith, type ParseOptions } from './engine.js'
export { verifyParser, type SafetyIssue, type SafetyReport } from './verify.js'

// Use-case contracts
export {
  pendingPurchasesContract,
  pendingPurchasesOutputFields,
  ParsedProductNameSchema,
  type ParsedProductName,
} from './contracts/pendingPurchases.js'

// Dialect packs
export { metrcV1Dialect } from './dialects/metrc-v1.js'
