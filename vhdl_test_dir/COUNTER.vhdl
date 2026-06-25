--========================================
--
-- Author:	AUTHOR
-- Date:	March 30, 2026
-- Course:	COURSE
--
-- Description: Counter; Used to test e2c with generics
--========================================

-- Library Declaration
LIBRARY ieee;
USE ieee.std_logic_1164.all;
USE ieee.numeric_std.all;

ENTITY COUNTER IS
GENERIC (
    data_width : INTEGER := 32
);
PORT (
    i_clk       : IN  STD_LOGIC;
    i_count_en  : IN  STD_LOGIC;
    i_reset_l   : IN  STD_LOGIC;

    o_out       : OUT STD_LOGIC_VECTOR(data_width - 1 DOWNTO 0)
);
END COUNTER;

ARCHITECTURE struct OF COUNTER IS
-- SIGNALS

SIGNAL internal : STD_LOGIC_VECTOR(data_width - 1 DOWNTO 0);


BEGIN

PROCESS (i_clk, i_reset_l)
BEGIN

    IF (i_reset_l = '0') THEN
        o_out <= (OTHERS => '0');
    ELSIF (rising_edge(i_clk)) THEN
        IF (i_count_en = '1') THEN
            internal <= STD_LOGIC_VECTOR(UNSIGNED(internal) + 1);
            o_out <= internal;
        ELSE
            o_out <= o_out;
        END IF;
    END IF;

END PROCESS;

END struct;