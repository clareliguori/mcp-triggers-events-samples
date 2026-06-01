import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Re-export the bits-ui prop helper types used by the generated shadcn-svelte
// components (Select/Input/Textarea/Card/Label) so they can import them from a
// single project-local module (`$lib/utils.js`).
export type WithElementRef<T, U extends EventTarget = HTMLElement> = T & {
  ref?: U | null;
};

export type WithoutChild<T> = T extends { child?: unknown }
  ? Omit<T, "child">
  : T;

export type WithoutChildren<T> = T extends { children?: unknown }
  ? Omit<T, "children">
  : T;

export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
