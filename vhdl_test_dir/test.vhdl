--========================================
--
-- Author:	AUTHOR
-- Date:	March 02, 2026
-- Course:	ANY COURSE
--
-- Description: Carry Lookahead Circuit
--		
--		
--		
--========================================
--
-- Library Declaration
LIBRARY ieee;
USE ieee.std_logic_1164.all;

LIBRARY work;

USE work.types.all;

ENTITY CLC IS
PORT (
    i_a		: IN    STD_LOGIC_VECTOR(3 DOWNTO 0);
    i_b		: IN    STD_LOGIC_VECTOR(3 DOWNTO 0);
    i_cin   : IN    STD_LOGIC;
    o_cout  : INOUT STD_LOGIC_VECTOR(4 DOWNTO 0)
);
END CLC;

ARCHITECTURE rtl OF CLC IS

SUBTYPE address_t IS STD_LOGIC_VECTOR(15 DOWNTO 0);
SUBTYPE register_t IS STD_LOGIC_VECTOR(7 DOWNTO 0);

TYPE CU_States_t IS (FETCH, DECODE, EXECUTE, INTERRUPT, ERR);

-- COMPONENTS
FUNCTION GET_REG (reg : register_t; test : opcode_t) RETURN address_t IS VARIABLE SelectOut : address_t;
BEGIN
    SelectOut := (OTHERS => '1');

    RETURN SelectOut;
END FUNCTION;

-- SIGNALS
SIGNAL p    : STD_LOGIC_VECTOR(3 DOWNTO 0);
SIGNAL g    : STD_LOGIC_VECTOR(3 DOWNTO 0);
SIGNAL t    : address_t;
SIGNAL r    : register_t;

SIGNAL test_state : CU_States_t;

SIGNAL tet : opcode_t := (OTHERS => '0');

SIGNAL tet1 : sub_instr_t := (OTHERS => '0');
-- SIGNAL cout : STD_LOGIC_VECTOR(3 DOWNTO 0);

-- FUNCTIONS

BEGIN
p(0) <= i_a(0) XOR i_b(0);
p(1) <= i_a(1) XOR i_b(1);
p(2) <= i_a(2) XOR i_b(2);
p(3) <= i_a(3) XOR i_b(3);

g(0) <= i_a(0) AND i_b(0);
g(1) <= i_a(1) AND i_b(1);
g(2) <= i_a(2) AND i_b(2);
g(3) <= i_a(3) AND i_b(3);

o_cout(0) <= i_cin;
o_cout(1) <= g(0) OR (p(0) AND o_cout(0));
o_cout(2) <= g(1) OR (p(1) AND o_cout(1));
o_cout(3) <= g(2) OR (p(2) AND o_cout(2));
o_cout(4) <= g(3) OR (p(3) AND o_cout(3));

t <= GET_REG(r);

test : PROCESS
BEGIN
    GET_CURRENT_INSTRUCTION(tet);
END PROCESS;

END rtl;