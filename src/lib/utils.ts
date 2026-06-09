import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 风格的类名合并工具：clsx + tailwind-merge。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
