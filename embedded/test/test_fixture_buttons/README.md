# Fixture buttons native tests

These tests compile the actual firmware header against local GPIO/time/I2C mocks.
The I2C mock implements write-one-to-clear status, so preservation assertions
cover other pending PMU interrupts and interrupt enables.

From the repository root (Unity is installed by the embedded native test environment):

```sh
vp exec cc -Iembedded/test/.pio/libdeps/native/Unity/src -c embedded/test/.pio/libdeps/native/Unity/src/unity.c -o /private/tmp/fixture-buttons-unity.o
vp exec c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -Iembedded/test/test_fixture_buttons/mocks -Iembedded/test/.pio/libdeps/native/Unity/src embedded/test/test_fixture_buttons/test_fixture_buttons.cpp /private/tmp/fixture-buttons-unity.o -o /private/tmp/fixture-buttons-tests
vp exec /private/tmp/fixture-buttons-tests
```

Use the local mocks include directory before shared Arduino mocks when integrating
this suite into a native test runner. No USB or physical hardware is accessed.
