import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { SECTION_IDS } from "../lib/sections.ts";
import { Route } from "./index.tsx";

test("the page renders every section in the order the nav lists them", () => {
  const Home = Route.options.component as () => React.JSX.Element;
  const { container } = render(<Home />);

  const onPage = [...container.querySelectorAll("[id]")]
    .map((el) => el.id)
    .filter((id) => (SECTION_IDS as readonly string[]).includes(id));

  expect(onPage).toEqual(SECTION_IDS);
});
