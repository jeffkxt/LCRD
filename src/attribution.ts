/**
 * The attribution hook: the failure taxonomy, the relaxation-cause judgment,
 * and the trainability split as one replaceable bundle. The plugin ships the
 * log-heuristic default; a domain-specific task family can plug in its own
 * attribution rules by module so the produced dataset speaks that domain's
 * vocabulary without forking the plugin. Attribution is a pure function of the
 * recorded row — the hook never sees live tool results or the session.
 *
 * @module lcrd-attribution
 */
import type { DatasetRow, FailureClass, RelaxationCause, RelaxTypeInput, Trainability } from './dataset.ts'
import type { RelaxationAxis } from './instrumentation.ts'
import type { RelaxType } from './types.ts'
import { importModule } from './module-loader.ts'

/**
 * One attribution bundle: the classification decisions the dataset records. A
 * domain implementation may replace any or all of them; the default is the
 * log-heuristic taxonomy in `dataset.ts`.
 */
export interface Attribution {
  /**
   * Attribute one failed verdict to a failure class from its reason, exception
   * kind, and (when known) the verifier that recorded it. `verifierKind` is
   * optional so a domain bundle may ignore it.
   */
  classifyFailure(reason: string, exceptionKind?: string, verifierKind?: string): FailureClass
  /** Attribute one declaration's loosened check to a relaxation cause from the failure it followed. */
  classifyRelaxationCause(
    failureClass: FailureClass | null,
    failureExceptionKind: string | null,
    axes: RelaxationAxis[],
  ): RelaxationCause
  /**
   * Attribute one relaxation to its type: a specification adjustment, an
   * environmental rewrite, or a speculative strength drop. Omitted bundles use
   * the log heuristic, so an existing domain bundle keeps working unchanged.
   */
  classifyRelaxType?(input: RelaxTypeInput): RelaxType
  /**
   * Attribute one dataset row's trainability from its recorded type and
   * failure class. Only the fields the default taxonomy reads are required,
   * so a file-level exporter can stamp labels without a full `DatasetRow`.
   */
  classifyTrainability(row: Pick<DatasetRow, 'type' | 'pass' | 'failureClass' | 'strictness'>): Trainability
}

/**
 * Whether a value is a complete attribution bundle.
 * @param value - the loaded module export.
 * @returns true when every required decision is a function and the optional one, when present, is too.
 */
export function isAttribution(value: unknown): value is Attribution {
  if (typeof value !== 'object' || value === null) return false
  const bundle = value as Attribution
  if (typeof bundle.classifyFailure !== 'function') return false
  if (typeof bundle.classifyRelaxationCause !== 'function') return false
  if (typeof bundle.classifyTrainability !== 'function') return false
  if (bundle.classifyRelaxType !== undefined && typeof bundle.classifyRelaxType !== 'function') return false
  return true
}

/**
 * Load one attribution bundle from a module specifier. A relative or absolute
 * path is resolved against the base URL (the process working directory by
 * default) and loaded as a file URL; a bare specifier is imported as a package
 * name. The module exports the bundle as its default export, or as the module
 * namespace itself when it carries no default.
 * @param specifier - the module path or package name exporting the bundle.
 * @param baseUrl - directory for resolving a relative path; defaults to the process working directory.
 * @returns the loaded bundle, validated by {@link isAttribution}.
 */
export async function loadAttribution(specifier: string, baseUrl = process.cwd()): Promise<Attribution> {
  const attribution = await importModule(specifier, baseUrl)
  if (!isAttribution(attribution)) {
    throw new Error(`attribution module ${specifier} must export classifyFailure, classifyRelaxationCause, and classifyTrainability functions`)
  }
  return attribution
}
