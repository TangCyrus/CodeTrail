import { Button } from "./components/Button";
import { task } from "./callbacks";

export function App() {
  return <Button onClick={task} />;
}
