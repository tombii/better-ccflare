/**
 * Replace leading numeric line markers such as "123→" or "123â" by "123: ".
 */
export const cleanLineNumbers = (str: string): string =>
	str.replace(/^(\s*)(\d+)[→â]\s*/gm, "$1$2: ");
