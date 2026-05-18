/**
 * Worker-side parsekit wiring: config loader, git mirror, periodic
 * release registry. Node-only; do not import from the browser bundle.
 */

export {
  loadParserConfigsFromDir,
  type LoadError,
  type LoadOptions,
  type LoaderRegistries,
  type LoadResult,
} from './configLoader.js'

export {
  syncMirror,
  defaultMirrorPath,
  mirrorDirName,
  type FetchResult,
  type MirrorLogger,
  type MirrorOptions,
} from './gitMirror.js'

export {
  ParserRegistry,
  getParserRegistry,
  __resetParserRegistry,
  type InitOptions,
  type RegistryLogger,
  type RegistryStatus,
  type ReleaseSubscriber,
} from './parserRegistry.js'

export { bootstrapParserRegistry, buildRegistries, type BootstrapOptions } from './bootstrap.js'
