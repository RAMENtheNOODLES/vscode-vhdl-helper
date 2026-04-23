LIBRARY ieee;
USE ieee.std_logic_1164.all;
USE ieee.numeric_std.all;
LIBRARY work;

PACKAGE types IS
    -- TYPES
    SUBTYPE address_t       IS STD_LOGIC_VECTOR(15 DOWNTO 0);
    SUBTYPE file_reg_addr_t IS STD_LOGIC_VECTOR(4 DOWNTO 0);
    SUBTYPE instruction_t   IS STD_LOGIC_VECTOR(15 DOWNTO 0);
    SUBTYPE register_t      IS STD_LOGIC_VECTOR(7 DOWNTO 0);
    SUBTYPE opcode_t        IS STD_LOGIC_VECTOR(6 DOWNTO 0);
    SUBTYPE sub_instr_t     IS STD_LOGIC_VECTOR(2 DOWNTO 0);
    SUBTYPE data_t          IS STD_LOGIC_VECTOR(31 DOWNTO 0);
    SUBTYPE full_instr_t    IS STD_LOGIC_VECTOR(31 DOWNTO 0);

    -- MAIN CU STATES
    TYPE CU_States_t IS (FETCH, DECODE, EXECUTE, INTERRUPT, ERR);
    --TYPE Instruction_States_t IS (NOP, MOV, MBV, ADD, SUB, iAND, iOR, iXOR, iNOT, CMP, JMP, JEQ, JNE, JLT, JGT, JLE, JGE, HALT); -- anything with an i prepended is a vhdl keyword
    TYPE Instruction_States_t IS (NOP, LUI, AUIPC, JAL, JALR, BEQ, BNE,
        BLT, BGE, BLTU, BGEU, LB, LH, LW, 
        LBU, LHU, SB, SH, SW, ADDI, SLTI, SLTIU,
        XORI, ORI, ANDI, SLLI, SRLI, SRAI, ADD, SUB, 
        \SLL\, SLT, SLTU, \XOR\, \SRL\, \SRA\, \OR\,
        \AND\, FENCE, PAUSE, ECALL, BREAK
    );

    -- ALU States
    TYPE ALU_States_t IS (ADD, SUB, iAND, iOR, iXOR, iNOT, EQ, NEQ, GT, GTE, LT, LTE, WAITING);

    -- FUNCTIONS
    FUNCTION GET_CURRENT_INSTRUCTION (instruction : opcode_t; sub_instruction : sub_instr_t := "000"; sub_sub_instruction : opcode_t := (OTHERS => '0')) RETURN Instruction_States_t;
    FUNCTION EXEC_TO_VECTOR (instruction : Instruction_States_t) RETURN STD_LOGIC_VECTOR;
    FUNCTION INSTRUCTION_TO_VECTOR(instruction : CU_States_t) RETURN STD_LOGIC_VECTOR;
    FUNCTION VECTOR_TO_INSTRUCTION(instruction: STD_LOGIC_VECTOR(15 DOWNTO 0)) RETURN CU_States_t;
END PACKAGE types;  

PACKAGE BODY types IS 
    FUNCTION GET_CURRENT_INSTRUCTION (instruction : opcode_t; sub_instruction : sub_instr_t := "000"; sub_sub_instruction : opcode_t := (OTHERS => '0')) RETURN Instruction_States_t IS VARIABLE InstructionState : Instruction_States_t;
    BEGIN
        -- NOP, MOV, MBV, ADD, SUB, iAND, iOR, iXOR, iNOT, CMP, JMP, JEQ, JNE, JLT, JGT, JLE, JGE
        CASE instruction IS
            WHEN "0000000" 	=> InstructionState	:= NOP;
            WHEN "0110111"  => InstructionState := LUI;
            WHEN "0010111"  => InstructionState := AUIPC;
            WHEN "1101111"  => InstructionState := JAL;
            WHEN "1100111"  => InstructionState := JALR;
            -- Branching
            WHEN "1100011"  =>
                CASE sub_instruction IS
                    WHEN "000" => InstructionState	:= BEQ;
                    WHEN "001" => InstructionState	:= BNE;
                    WHEN "100" => InstructionState	:= BLT;
                    WHEN "101" => InstructionState	:= BGE;
                    WHEN "110" => InstructionState	:= BLTU;
                    WHEN "111" => InstructionState	:= BGEU;
                    WHEN OTHERS => InstructionState	:= NOP;
                END CASE;
            -- Loading
            WHEN "0000011" =>
                CASE sub_instruction IS
                    WHEN "000" => InstructionState	:= LB;
                    WHEN "001" => InstructionState	:= LH;
                    WHEN "010" => InstructionState	:= LW;
                    WHEN "100" => InstructionState	:= LBU;
                    WHEN "101" => InstructionState	:= LHU;
                    WHEN OTHERS => InstructionState	:= NOP;
                END CASE;
            -- Storing
            WHEN "0100011" =>
                CASE sub_instruction IS
                    WHEN "000" => InstructionState	:= SB;
                    WHEN "001" => InstructionState	:= SH;
                    WHEN "010" => InstructionState	:= SW;
                    WHEN OTHERS => InstructionState	:= NOP;
                END CASE;
            -- Integer Operations
            WHEN "0010011" =>
                CASE sub_instruction IS
                    WHEN "000" => InstructionState	:= ADDI;
                    WHEN "010" => InstructionState	:= SLTI;
                    WHEN "011" => InstructionState	:= SLTIU;
                    WHEN "100" => InstructionState	:= XORI;
                    WHEN "110" => InstructionState	:= ORI;
                    WHEN "111" => InstructionState	:= ANDI;
                    WHEN "001" => InstructionState	:= SLLI;
                    WHEN "101" =>
                        CASE sub_sub_instruction IS
                            WHEN "0000000" => InstructionState	:= SRLI;
                            WHEN OTHERS => InstructionState	    := SRAI;
                        END CASE;
                    WHEN OTHERS => InstructionState	:= NOP;
                END CASE;
            -- Operations
            WHEN "0110011" =>
                CASE sub_instruction IS
                    WHEN "000" =>
                        IF (sub_sub_instruction(5) = '0') THEN
                            InstructionState	:= ADD;
                        ELSE
                            InstructionState	:= SUB;
                        END IF;
                    WHEN "001" => InstructionState	:= \SLL\;
                    WHEN "010" => InstructionState	:= SLT;
                    WHEN "011" => InstructionState	:= SLTU;
                    WHEN "100" => InstructionState	:= \XOR\;
                    WHEN "101" =>
                        IF (sub_sub_instruction(5) = '0') THEN
                            InstructionState	:= \SRL\;
                        ELSE
                            InstructionState	:= \SRA\;
                        END IF;
                    WHEN "110" => InstructionState	:= \OR\;
                    WHEN "111" => InstructionState	:= \AND\;
                    WHEN OTHERS => InstructionState	:= NOP;
                END CASE;
            -- FENCE / PAUSE
            WHEN "0001111" =>
                IF (sub_instruction = "000") THEN
                    InstructionState	:= NOP; -- FOR NOW
                ELSE
                    InstructionState	:= NOP;
                END IF;
            -- ECALL / EBREAK
            WHEN "1110011" => InstructionState	:= NOP; -- FOR NOW
            WHEN OTHERS => InstructionState	:= NOP;
        END CASE;
	    RETURN InstructionState;
    END FUNCTION;

    FUNCTION EXEC_TO_VECTOR (instruction : Instruction_States_t) RETURN STD_LOGIC_VECTOR IS VARIABLE InstructionState : STD_LOGIC_VECTOR(15 DOWNTO 0);
        BEGIN
        CASE instruction IS
            WHEN NOP    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0000#, 16));
            -- WHEN MOV    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0001#, 16));
            -- WHEN MBV    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0002#, 16));
            -- WHEN ADD    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0003#, 16));
            -- WHEN SUB    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0004#, 16));
            -- WHEN iAND   => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0005#, 16));
            -- WHEN iOR    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0006#, 16));
            -- WHEN iXOR   => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0007#, 16));
            -- WHEN iNOT   => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0008#, 16));
            -- WHEN CMP    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0009#, 16));
            -- WHEN JMP    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000A#, 16));
            -- WHEN JEQ    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000B#, 16));
            -- WHEN JNE    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000C#, 16));
            -- WHEN JLT    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000D#, 16));
            -- WHEN JGT    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000E#, 16));
            -- WHEN JLE    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#000F#, 16));
            -- WHEN JGE    => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0010#, 16));
            -- WHEN HALT	=> InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#FFFF#, 16));
            WHEN OTHERS => InstructionState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0000#, 16));
        END CASE;

	    RETURN InstructionState;
    END FUNCTION;

    FUNCTION INSTRUCTION_TO_VECTOR(instruction : CU_States_t) RETURN STD_LOGIC_VECTOR IS VARIABLE CUState : STD_LOGIC_VECTOR(15 DOWNTO 0);
        BEGIN
        CASE instruction IS
            WHEN FETCH =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0000#, 16));
            WHEN DECODE =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0001#, 16));
            WHEN EXECUTE =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0002#, 16));
            WHEN ERR =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0003#, 16));
            WHEN INTERRUPT =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0004#, 16));
            WHEN OTHERS =>
                CUState := STD_LOGIC_VECTOR(TO_UNSIGNED(16#0002#, 16));
        END CASE;

	    RETURN CUState;
    END FUNCTION;

    FUNCTION VECTOR_TO_INSTRUCTION(instruction: STD_LOGIC_VECTOR(15 DOWNTO 0)) RETURN CU_States_t IS VARIABLE CUState : CU_States_t;
        BEGIN
	    CASE instruction IS
            WHEN x"0000" =>
                CUState := FETCH;
            WHEN x"0001" =>
                CUState := DECODE;
            WHEN x"0002" =>
                CUState := EXECUTE;
            WHEN x"0003" =>
                CUState := ERR;
            WHEN x"0004" =>
                CUState := INTERRUPT;
            WHEN OTHERS =>
                CUState := ERR;
	    END CASE;

	    RETURN CUState;
    END FUNCTION;

END PACKAGE BODY types;