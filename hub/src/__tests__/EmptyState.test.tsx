import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmptyState from "@/components/EmptyState";
import { Vault } from "lucide-react";

describe("EmptyState", () => {
  it("displays title and description", () => {
    render(
      <EmptyState
        icon={Vault}
        title="No games yet"
        description="No connected games found."
        actionLabel="Connect a game"
        actionHref="/my-games"
      />,
    );

    expect(screen.getByText("No games yet")).toBeInTheDocument();
    expect(screen.getByText("No connected games found.")).toBeInTheDocument();
    expect(screen.getByText("Connect a game")).toBeInTheDocument();
  });

  it("does not render action link when no actionLabel", () => {
    render(<EmptyState icon={Vault} title="Empty" description="Nothing to show." />);

    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
