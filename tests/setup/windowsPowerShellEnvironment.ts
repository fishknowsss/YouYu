import { prepareWindowsPowerShellFixtureEnvironment } from '../helpers/windowsPowerShellEnvironment';

// Always discard inherited module paths. Repeated script fixtures may reuse only an existing local
// analysis-cache file supplied by the runner; production launchers still scrub both settings.
prepareWindowsPowerShellFixtureEnvironment();
