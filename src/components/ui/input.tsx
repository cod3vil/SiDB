import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground",
          "placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
