/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package is a browser platform module: the shell provides it through
 * the injected `require`, and in Node its own import chain (clsx, katex, shiki,
 * micromark, …) would have to be installed just to render a test component. The
 * vitest config aliases the specifier here instead.
 *
 * It exports BOTH icon generations, so a component test exercises the same
 * lookup the browser half performs. Which generation a given shell provides is
 * covered by `icons.spec.ts` with plain lookup tables.
 * @module
 */
export const IconChecklistOutlineMedium = () => null
export const IconChecklistOutline14 = () => null
export const IconChevronDownOutlineMedium = () => null
export const IconChevronDownOutline14 = () => null
export const IconChevronUpOutlineMedium = () => null
export const IconChevronUpOutline14 = () => null
