-- Test file for unused symbol detection
LIBRARY ieee;
USE ieee.std_logic_1164.all;

ENTITY test_unused IS
  PORT (
    clk : IN STD_LOGIC;
    reset : IN STD_LOGIC;
    data_out : OUT STD_LOGIC_VECTOR(7 DOWNTO 0)
  );
END test_unused;

ARCHITECTURE rtl OF test_unused IS
  -- Signals
  SIGNAL used_signal : STD_LOGIC;           -- This is used
  SIGNAL unused_signal : STD_LOGIC;         -- This should be grayed out
  SIGNAL another_unused : STD_LOGIC_VECTOR(7 DOWNTO 0);  -- This should be grayed out
  SIGNAL temp_used : STD_LOGIC_VECTOR(7 DOWNTO 0);       -- This is used
  
BEGIN

  PROCESS(clk, reset)
  VARIABLE used_var : STD_LOGIC;           -- This is used
  VARIABLE unused_var : STD_LOGIC;         -- This should be grayed out
  VARIABLE counter : INTEGER;              -- This should be grayed out
  BEGIN
    IF reset = '1' THEN
      used_signal <= '0';
      used_var := '0';
      temp_used <= (OTHERS => '0');
      data_out <= (OTHERS => '0');
    ELSIF rising_edge(clk) THEN
      used_signal <= NOT used_signal;
      used_var := used_signal;
      temp_used <= temp_used(6 DOWNTO 0) & used_var;
      data_out <= temp_used;
    END IF;
  END PROCESS;

END rtl;
