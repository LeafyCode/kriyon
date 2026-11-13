import { expect, test } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import { App } from "./App.tsx";

test("the shell opens on Kriyon", async () => {
  await render(<App />);
  expect(screen.getByText("Kriyon")).toBeOnTheScreen();
});
