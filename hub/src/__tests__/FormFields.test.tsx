import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Input, Textarea, Select, Checkbox } from "@/components/FormFields";

describe("FormFields", () => {
  it("Input renders with label and error", () => {
    render(<Input label="Full name" name="name" error="This field is required" />);
    expect(screen.getByText("Full name")).toBeInTheDocument();
    expect(screen.getByText("This field is required")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("Textarea renders correctly", () => {
    render(<Textarea label="Description" name="desc" />);
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("Select renders with options", () => {
    render(
      <Select
        label="Game"
        name="game"
        options={[
          { value: "roll_raider", label: "Roll Raider" },
          { value: "neon_knights", label: "Neon Knights" },
        ]}
      />,
    );
    expect(screen.getByText("Game")).toBeInTheDocument();
    expect(screen.getByText("Roll Raider")).toBeInTheDocument();
    expect(screen.getByText("Neon Knights")).toBeInTheDocument();
  });

  it("Checkbox renders with label", () => {
    render(<Checkbox label="I agree" name="terms" />);
    expect(screen.getByText("I agree")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });
});
