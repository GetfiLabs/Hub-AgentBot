"use client";

import { motion } from "framer-motion";
import { ArrowRight, LucideIcon } from "lucide-react";
import Link from "next/link";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  actionOnClick?: () => void;
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  actionOnClick,
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="panel flex min-h-[42vh] flex-col items-center justify-center p-8 text-center"
    >
      <motion.div
        animate={{ y: [0, -4, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        className="grid h-20 w-20 place-items-center rounded-2xl border border-cyan-300/20"
        style={{
          background: "linear-gradient(135deg, rgba(61,231,255,0.12), rgba(180,139,255,0.08))",
          boxShadow: "0 0 40px -10px var(--cyan-glow)",
        }}
      >
        <Icon className="h-9 w-9 text-[var(--cyan)]" aria-hidden="true" />
      </motion.div>
      <h2 className="mt-5 text-xl font-black text-heading">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--muted)]">{description}</p>
      {actionLabel && actionHref && (
        <Link href={actionHref} className="command-button mt-6 inline-flex px-5">
          {actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
      )}
      {actionLabel && actionOnClick && !actionHref && (
        <button onClick={actionOnClick} className="command-button mt-6 inline-flex px-5">
          {actionLabel}
        </button>
      )}
    </motion.div>
  );
}
